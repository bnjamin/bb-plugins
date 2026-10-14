import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createFakePluginHost, experimental_scanPublicSdkOnly, makeHostResponse, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { Boat, type Sandbox } from "../boat.js";
import { createPlugin } from "../server.js";
import { lifecycle, allocationStorageKey, idleKey, expiryWakeKey, expiryWarningKey } from "../lifecycle.js";
import { configSchema, type Config, type Resource } from "../config.js";
import { BoatRest } from "../rest.js";

const resource: Resource = { version: 1, key: "launch1", scope: "personal", accountIdentity: "account1", sandboxId: "bx_test", ttlSeconds: 3600 };
const report = { step: (_: string) => {}, log: (_: string) => {} };
class FakeBoat extends Boat {
  calls: string[] = [];
  createFailure: "before" | "after" | null = null;
  failStop = false;
  account = "account1";
  state: Sandbox = { id: "bx_test", state: "ready", archiveAfter: new Date(Date.now() + 60_000).toISOString() };
  constructor(rest?: BoatRest) { super("boat", "personal", undefined, rest); }
  override async preflight() { this.calls.push("preflight"); }
  override async accountIdentity() { return this.account; }
  override async cliAccountIdentity() { return this.account; }
  override async checkTransportsMatch() { this.calls.push("transports"); }
  override async create(_: Config, __: string, ___: AbortSignal, allocated: (id: string) => Promise<void>) {
    this.calls.push("new");
    if (this.createFailure === "before") throw new Error("response lost");
    await allocated("bx_test");
    if (this.createFailure === "after") throw new Error("readiness failed");
    return "bx_test";
  }
  override async resume() { this.calls.push("resume"); }
  override async prepare() { this.calls.push("prepare"); }
  override async remove() { this.calls.push("remove"); }
  override async stop() { this.calls.push("stop"); if (this.failStop) throw new Error("snapshot failed"); }
  override async info() { this.calls.push("info"); return this.state; }
  override async extend() { this.calls.push("extend"); }
  override async allocationKey() { return "launch1"; }
}

async function fixture(options: { api?: boolean } = {}) {
  const boat = new FakeBoat(options.api ? new BoatRest("boat_test", "personal", (async () => { throw new Error("unused"); }) as typeof fetch) : undefined);
  const checkpoints: Resource[] = [];
  const scopes: string[] = [];
  let current = configSchema.parse({});
  const { bb, harness } = createFakePluginHost({
    pluginId: "boat-sandbox",
    machineBootstrap: { bootstrap: async ({ key }) => {
      assert.equal(key, "launch1");
      assert.ok(checkpoints.length > 0, "checkpoint precedes bootstrap");
      boat.calls.push("bootstrap"); return { hostId: "host1" };
    } },
  });
  const controller = new AbortController();
  const manager = lifecycle(bb, async () => current, async (scope) => { scopes.push(scope); return boat; }, controller.signal);
  const context = { key: "launch1", inputs: {}, attempt: 1, report, signal: controller.signal,
    checkpoint: async (value: unknown) => { checkpoints.push(value as Resource); } };
  return { boat, bb, harness, manager, context, checkpoints, scopes, changeScope: () => { current = { ...current, scope: "team_new" }; } };
}

test("create checkpoints before enrollment and retries reuse the original scope", async (t) => {
  const f = await fixture(); t.after(() => f.harness.lifecycle.dispose());
  const logs: string[] = [];
  const first = await f.manager.definition.create({ ...f.context, report: { step: () => {}, log: (text: string) => logs.push(text) } });
  assert.equal(first.status, "created");
  // Preflight and the account lookup run together; the login proven there is
  // reused for preparation and enrollment, and one timing summary is reported.
  assert.deepEqual(f.boat.calls, ["preflight", "transports", "new", "prepare", "bootstrap"]);
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /^Boat create of bx_test took \d+\.\ds \(preflight \d+\.\ds, sandbox \d+\.\ds, prepare \d+\.\ds, daemon \d+\.\ds\)\.\n$/);
  f.changeScope();
  await f.manager.definition.create({ ...f.context, attempt: 2 });
  assert.equal(f.boat.calls.filter((call) => call === "new").length, 1);
  assert.deepEqual(f.checkpoints, [resource, resource]);
  assert.ok(f.scopes.every((scope) => scope === "personal"));
});

test("lost create response blocks duplicate allocation and cleanup until reconciled", async (t) => {
  const f = await fixture(); t.after(() => f.harness.lifecycle.dispose());
  f.boat.createFailure = "before";
  await assert.rejects(f.manager.definition.create(f.context), /response lost/);
  await assert.rejects(f.manager.definition.create(f.context), /Uncertain Boat allocation/);
  assert.equal(f.boat.calls.filter((call) => call === "new").length, 1);
  assert.equal((await f.manager.definition.reconcileCleanup(f.context)).status, "failed");
  await f.manager.recover("launch1", "bx_test", f.context.signal);
  assert.equal((await f.manager.definition.reconcileCleanup(f.context)).status, "removed");
  assert.ok(f.boat.calls.includes("remove"));
  await assert.rejects(f.manager.definition.create(f.context), /was removed/);
});

test("partial allocation survives bootstrap/readiness failures for cleanup", async (t) => {
  const f = await fixture(); t.after(() => f.harness.lifecycle.dispose());
  f.boat.createFailure = "after";
  await assert.rejects(f.manager.definition.create(f.context), /readiness failed/);
  assert.equal(f.checkpoints[0]?.sandboxId, "bx_test");
  const stored = await f.bb.storage.kv.get<{ sandboxId: string }>(allocationStorageKey("launch1"));
  assert.equal(stored?.sandboxId, "bx_test");
  await f.manager.definition.reconcileCleanup(f.context);
  assert.ok(f.boat.calls.includes("remove"));
});

test("sleep failure does not checkpoint success; resume reuses enrollment key", async (t) => {
  const f = await fixture(); t.after(() => f.harness.lifecycle.dispose());
  const context = { ...f.context, hostId: "host1", resource };
  f.boat.failStop = true;
  await assert.rejects(f.manager.definition.suspend!(context), /snapshot failed/);
  assert.equal(f.checkpoints.length, 0);
  f.boat.failStop = false;
  await f.manager.definition.suspend!(context);
  await f.manager.definition.resume!(context);
  assert.deepEqual(f.checkpoints, [resource, resource]);
  assert.ok(!f.boat.calls.includes("new"));
  assert.ok(!f.boat.calls.includes("remove"));
});

test("recovery cannot adopt a sandbox with a different launch marker", async (t) => {
  const f = await fixture(); t.after(() => f.harness.lifecycle.dispose());
  await f.bb.storage.kv.set(allocationStorageKey("other"), { key: "other", scope: "personal", accountIdentity: "account1", sandboxId: null, ttlSeconds: 3600 });
  await assert.rejects(f.manager.recover("other", "bx_test", f.context.signal), /does not match/);
});

test("registered plugin uses BB composition and renews before coordinated idle suspension", async (t) => {
  const boat = new FakeBoat();
  const host = makeHostResponse({ id: "host1", machineProviderId: "boat-sandbox", lifecycle: { phase: "active", message: null, pendingLog: "", suspendedAt: null, teardown: null } });
  const { bb, harness } = createFakePluginHost({
    pluginId: "boat-sandbox", machineResource: async () => resource,
    sdk: { hosts: { list: async () => [host], experimental_suspend: async () => { boat.calls.push("suspend-core"); } } },
  });
  t.after(() => harness.lifecycle.dispose());
  await createPlugin(async () => boat)(bb);
  const composition = harness.inspection.registrations.environmentCompositions.get("boat-sandbox");
  assert.equal(composition?.environmentProviderId, "project-checkout");
  assert.ok(harness.inspection.registrations.machineProviders.has("boat-sandbox"));
  await bb.storage.kv.set(idleKey("host1"), Date.now() - 60 * 60_000);
  await harness.behavior.runSchedule("maintain-boat-machines");
  assert.deepEqual(boat.calls, ["info", "extend", "suspend-core"]);
  const doctor = await harness.behavior.runCli(["doctor", "--json"]);
  assert.equal(doctor.exitCode, 0);
  assert.equal(JSON.parse(doctor.stdout).scope, "personal");
});

test("external auto-stop is reconciled through core without extending stopped compute", async (t) => {
  const boat = new FakeBoat(); boat.state.state = "archived";
  const host = makeHostResponse({ id: "host1", machineProviderId: "boat-sandbox", lifecycle: { phase: "active", message: null, pendingLog: "", suspendedAt: null, teardown: null } });
  const { bb, harness } = createFakePluginHost({
    pluginId: "boat-sandbox", machineResource: async () => resource,
    sdk: { hosts: { list: async () => [host], experimental_suspend: async () => { boat.calls.push("suspend-core"); } } },
  });
  t.after(() => harness.lifecycle.dispose());
  await createPlugin(async () => boat)(bb);
  await harness.behavior.runSchedule("maintain-boat-machines");
  assert.deepEqual(boat.calls, ["info", "suspend-core"]);
});

test("package uses only public BB APIs", async () => {
  const scan = await experimental_scanPublicSdkOnly(fileURLToPath(new URL("..", import.meta.url)), {
    allow: [/^react$/, /^jsdom$/, /^@testing-library\/react$/],
  });
  assert.deepEqual(scan.violations, []);
  assert.deepEqual(scan.privateDependencies, []);
});

test("account changes cannot turn inaccessible sandboxes into successful cleanup", async (t) => {
  const f = await fixture(); t.after(() => f.harness.lifecycle.dispose());
  await f.manager.definition.create(f.context);
  f.boat.account = "different-account";
  await assert.rejects(f.manager.definition.remove({ ...f.context, hostId: "host1", resource }), /Boat login changed/);
  assert.ok(!f.boat.calls.includes("remove"));
  assert.ok(await f.bb.storage.kv.get(allocationStorageKey("launch1")));
});

async function sleepingFixture(t: { after(fn: () => unknown): void }, options: { state: Sandbox; suspendedAt?: number; settings?: Record<string, number> }) {
  const boat = new FakeBoat(); boat.state = options.state;
  const host = makeHostResponse({ id: "host1", machineProviderId: "boat-sandbox", lifecycle: { phase: "suspended", message: null, pendingLog: "", suspendedAt: options.suspendedAt ?? Date.now(), teardown: null } });
  const { bb, harness } = createFakePluginHost({
    pluginId: "boat-sandbox", machineResource: async () => resource, settings: options.settings,
    sdk: { hosts: {
      list: async () => [host],
      experimental_reconcile: async () => { boat.calls.push("reconcile-core"); return host; },
      experimental_resume: async () => { boat.calls.push("resume-core"); return host; },
      experimental_suspend: async () => { boat.calls.push("suspend-core"); return host; },
    } },
  });
  t.after(() => harness.lifecycle.dispose());
  await createPlugin(async () => boat)(bb);
  return { boat, bb, harness };
}
const daysAgo = (days: number) => Date.now() - days * 86_400_000 - 60_000;

test("running compute behind a sleeping machine is reconciled through core", async (t) => {
  const { boat, harness } = await sleepingFixture(t, { state: { id: "bx_test", state: "ready" } });
  await harness.behavior.runSchedule("maintain-boat-machines");
  assert.deepEqual(boat.calls, ["info", "reconcile-core"]);
  assert.ok(harness.inspection.logEntries.some((entry) => entry.level === "warn" && /running while BB has host1 asleep/.test(entry.message)));
});

test("a stopped machine asleep for less than the wake threshold is left alone", async (t) => {
  const { boat, harness } = await sleepingFixture(t, { state: { id: "bx_test", state: "stopped", snapshotCompletedAt: new Date(daysAgo(3)).toISOString() } });
  await harness.behavior.runSchedule("maintain-boat-machines");
  assert.deepEqual(boat.calls, ["info"]);
});

test("long sleepers are woken once before Boat deletes their disk", async (t) => {
  // Boat's stop snapshot time wins over BB's later suspension time.
  const { boat, harness } = await sleepingFixture(t, { state: { id: "bx_test", state: "stopped", snapshotCompletedAt: new Date(daysAgo(12)).toISOString() }, suspendedAt: daysAgo(1) });
  await harness.behavior.runSchedule("maintain-boat-machines");
  await harness.behavior.runSchedule("maintain-boat-machines");
  assert.deepEqual(boat.calls, ["info", "resume-core", "info"], "a second sweep must not spend another start");
});

test("without automatic waking, long sleepers warn once a day instead", async (t) => {
  for (const settings of [{ wakeBeforeExpiryDays: 0 }, { idleMinutes: 0 }] as Record<string, number>[]) {
    const { boat, harness } = await sleepingFixture(t, { state: { id: "bx_test", state: "archived" }, suspendedAt: daysAgo(12), settings });
    await harness.behavior.runSchedule("maintain-boat-machines");
    await harness.behavior.runSchedule("maintain-boat-machines");
    assert.ok(!boat.calls.includes("resume-core"));
    const warnings = harness.inspection.logEntries.filter((entry) => /asleep 12 days/.test(entry.message));
    assert.equal(warnings.length, 1);
  }
});

test("waking a machine resets its expiry bookkeeping", async (t) => {
  const f = await fixture(); t.after(() => f.harness.lifecycle.dispose());
  await f.bb.storage.kv.set(expiryWakeKey("host1"), Date.now());
  await f.bb.storage.kv.set(expiryWarningKey("host1"), 12);
  await f.manager.definition.resume!({ ...f.context, hostId: "host1", resource });
  assert.equal(await f.bb.storage.kv.get(expiryWakeKey("host1")), undefined);
  assert.equal(await f.bb.storage.kv.get(expiryWarningKey("host1")), undefined);
});

test("through the API, a lost create response is retried with the same request instead of becoming uncertain", async (t) => {
  const f = await fixture({ api: true }); t.after(() => f.harness.lifecycle.dispose());
  const requests: unknown[] = [];
  const create = f.boat.create.bind(f.boat);
  f.boat.create = async (config, key, signal, allocated) => { requests.push(config); return create(config as Config, key, signal, allocated); };
  f.boat.createFailure = "before";
  await assert.rejects(f.manager.definition.create(f.context), /response lost/);
  f.changeScope();
  f.boat.createFailure = null;
  const second = await f.manager.definition.create({ ...f.context, attempt: 2 });
  assert.equal(second.status, "created");
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1], requests[0], "an idempotent retry must repeat the original request");
  assert.ok(f.scopes.every((scope) => scope === "personal"), "the retry keeps the original billing scope");
  assert.deepEqual(f.checkpoints.at(-1), resource);
});

test("after Boat's 24-hour idempotency window an unconfirmed allocation stays uncertain", async (t) => {
  const f = await fixture({ api: true }); t.after(() => f.harness.lifecycle.dispose());
  f.boat.createFailure = "before";
  await assert.rejects(f.manager.definition.create(f.context), /response lost/);
  const stored = await f.bb.storage.kv.get<Record<string, unknown>>(allocationStorageKey("launch1"));
  await f.bb.storage.kv.set(allocationStorageKey("launch1"), { ...stored, requestedAt: Date.now() - 24 * 60 * 60_000 });
  f.boat.createFailure = null;
  await assert.rejects(f.manager.definition.create({ ...f.context, attempt: 2 }), /Uncertain Boat allocation/);
  assert.equal(f.boat.calls.filter((call) => call === "new").length, 1);
});

test("a request first sent through the CLI is never retried with an idempotency key Boat never saw", async (t) => {
  const f = await fixture(); t.after(() => f.harness.lifecycle.dispose());
  f.boat.createFailure = "before";
  await assert.rejects(f.manager.definition.create(f.context), /response lost/);
  // An API key is configured before the retry.
  const api = new FakeBoat(new BoatRest("boat_test", "personal", (async () => { throw new Error("unused"); }) as typeof fetch));
  const manager = lifecycle(f.bb, async () => configSchema.parse({}), async () => api, new AbortController().signal);
  await assert.rejects(manager.definition.create({ ...f.context, attempt: 2 }), /Uncertain Boat allocation/);
  assert.ok(!api.calls.includes("new"));
});
