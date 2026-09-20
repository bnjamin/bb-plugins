import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createFakePluginHost, experimental_scanPublicSdkOnly, makeHostResponse, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { Boat, type Sandbox } from "../boat.js";
import { createPlugin } from "../server.js";
import { lifecycle, allocationStorageKey, idleKey } from "../lifecycle.js";
import { configSchema, type Config, type Resource } from "../config.js";

const resource: Resource = { version: 1, key: "launch1", scope: "personal", accountIdentity: "account1", sandboxId: "bx_test", ttlSeconds: 3600 };
const report = { step: (_: string) => {}, log: (_: string) => {} };
class FakeBoat extends Boat {
  calls: string[] = [];
  createFailure: "before" | "after" | null = null;
  failStop = false;
  account = "account1";
  state: Sandbox = { id: "bx_test", state: "ready", archiveAfter: new Date(Date.now() + 60_000).toISOString() };
  constructor() { super("boat", "personal"); }
  override async preflight() { this.calls.push("preflight"); }
  override async accountIdentity() { return this.account; }
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

async function fixture() {
  const boat = new FakeBoat();
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
  assert.deepEqual(f.boat.calls, ["preflight", "new", "prepare", "bootstrap"]);
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

const sharedUrl = "https://sofia.on.boat.dev/?_token=secret";
async function shareFixture() {
  const host = makeHostResponse({ id: "sandbox", status: "connected", machineProviderId: "boat-sandbox", lifecycle: { phase: "active", message: null, pendingLog: "", suspendedAt: null, teardown: null } });
  const desktopHost = makeHostResponse({ id: "mac", status: "connected" });
  const { bb, harness } = createFakePluginHost({
    pluginId: "boat-sandbox",
    experimental_callHostRpc: async (call) => {
      assert.equal(call.hostId, "sandbox");
      assert.equal(call.method, "share");
      assert.deepEqual(call.input, { workspacePath: "/remote/sofia", port: 3000 });
      return { url: sharedUrl };
    },
  });
  harness.sdk.stub("threads.get", async () => makeThreadResponse({ id: "thread1", environmentId: "env1" }));
  harness.sdk.stub("environments.get", async () => ({ id: "env1", hostId: "sandbox", path: "/remote/sofia" }));
  harness.sdk.stub("hosts.get", async () => host);
  harness.sdk.stub("hosts.list", async () => [host, desktopHost]);
  harness.sdk.stub("experimental_desktopBrowsers.listInstances", async (input: { hostId: string }) => ({ instances: input.hostId === "mac" ? [{ hostId: "mac", instanceId: "window", generation: "current" }] : [] }));
  harness.sdk.stub("experimental_desktopBrowsers.listTabs", async () => ({ tabs: [] }));
  harness.sdk.stub("experimental_desktopBrowsers.createTab", async () => ({ tab: { tabId: "tab1" } }));
  await createPlugin()(bb);
  return { bb, harness };
}

test("share resolves the thread environment, targets its Boat host and opens the private URL in the thread's browser", async (t) => {
  const { harness } = await shareFixture();
  t.after(() => harness.lifecycle.dispose());
  const result = await harness.behavior.runCli(["share", "--thread", "thread1", "--json"]);
  assert.equal(result.exitCode, 0);
  assert.equal(harness.inspection.experimental_hostRpcCalls.length, 1);
  const payload = JSON.parse(result.stdout!);
  assert.equal(payload.url, sharedUrl);
  assert.equal(payload.browser, "opened");
  assert.deepEqual(payload.browserTarget, { hostId: "mac", instanceId: "window" });
  const call = harness.sdk.callsTo("experimental_desktopBrowsers.createTab")[0]!;
  assert.match(JSON.stringify(call), /thread1/);
  assert.match(JSON.stringify(call), /_token=secret/);
});

test("share withholds tokens by default and requires explicit URL output", async (t) => {
  const { harness } = await shareFixture();
  t.after(() => harness.lifecycle.dispose());
  const plain = await harness.behavior.runCli(["share", "--thread", "thread1"]);
  assert.equal(plain.exitCode, 0);
  assert.match(plain.stdout!, /https:\/\/sofia.on.boat.dev/);
  assert.match(plain.stdout!, /withheld/);
  assert.doesNotMatch(JSON.stringify(plain), /_token|secret/);
  const explicit = await harness.behavior.runCli(["share", "--url", "--thread", "thread1"]);
  assert.equal(explicit.exitCode, 0);
  assert.equal(explicit.stdout, sharedUrl);
});

test("share reports no target when the selected Boat host has no desktop", async (t) => {
  const { harness } = await shareFixture();
  t.after(() => harness.lifecycle.dispose());
  const payload = JSON.parse((await harness.behavior.runCli(["share", "--thread", "thread1", "--browser-host", "sandbox", "--json"])).stdout!);
  assert.equal(payload.browser, "unavailable");
  assert.equal(payload.browserTarget, null);
  assert.match(payload.message, /0 desktop windows matched/);
  assert.equal(harness.sdk.callsTo("experimental_desktopBrowsers.createTab").length, 0);
  const plain = await harness.behavior.runCli(["share", "--thread", "thread1", "--browser-host", "sandbox"]);
  assert.doesNotMatch(JSON.stringify(plain), /_token|secret/);
  assert.match(plain.stdout!, /withheld/);
});

test("share does not report a browser target when the desktop operation fails", async (t) => {
  const { harness } = await shareFixture();
  t.after(() => harness.lifecycle.dispose());
  harness.sdk.stub("experimental_desktopBrowsers.createTab", async () => { throw new Error("desktop disconnected"); });
  const payload = JSON.parse((await harness.behavior.runCli(["share", "--thread", "thread1", "--json"])).stdout!);
  assert.equal(payload.browser, "unavailable");
  assert.equal(payload.browserTarget, null);
});

test("share reveals a tab already on the shared origin instead of duplicating it", async (t) => {
  const { harness } = await shareFixture();
  t.after(() => harness.lifecycle.dispose());
  // The app strips the token on redirect, so the open tab no longer carries it.
  harness.sdk.stub("experimental_desktopBrowsers.listTabs", async () => ({ tabs: [{ tabId: "existing", url: "https://sofia.on.boat.dev/users/login" }] }));
  harness.sdk.stub("experimental_desktopBrowsers.revealTab", async () => ({ ok: true }));
  const payload = JSON.parse((await harness.behavior.runCli(["share", "--thread", "thread1", "--json"])).stdout!);
  assert.equal(payload.browser, "reused");
  assert.equal(payload.url, sharedUrl);
  assert.equal(harness.sdk.callsTo("experimental_desktopBrowsers.createTab").length, 0);
});

test("share still returns the private link when no single desktop window can be chosen", async (t) => {
  const { harness } = await shareFixture();
  t.after(() => harness.lifecycle.dispose());
  harness.sdk.stub("experimental_desktopBrowsers.listInstances", async () => ({ instances: [{ hostId: "mac", instanceId: "one", generation: "current" }, { hostId: "mac", instanceId: "two", generation: "current" }] }));
  const many = JSON.parse((await harness.behavior.runCli(["share", "--thread", "thread1", "--json"])).stdout!);
  assert.equal(many.browser, "unavailable");
  assert.equal(many.url, sharedUrl);
  assert.match(many.message, /--browser-instance/);
  harness.sdk.stub("hosts.list", async () => { throw new Error("offline"); });
  const offline = JSON.parse((await harness.behavior.runCli(["share", "--thread", "thread1", "--json"])).stdout!);
  assert.equal(offline.browser, "unavailable");
  assert.equal(offline.url, sharedUrl);
  assert.doesNotMatch(offline.message, /--browser-instance/);
});

test("share passes an explicit desktop window through to the browser lookup", async (t) => {
  const { harness } = await shareFixture();
  t.after(() => harness.lifecycle.dispose());
  const result = await harness.behavior.runCli(["share", "--thread", "thread1", "--browser-host", "mac", "--browser-instance", "window", "--json"]);
  assert.equal(JSON.parse(result.stdout!).browser, "opened");
  assert.deepEqual(harness.sdk.callsTo("experimental_desktopBrowsers.listInstances").map(([input]) => (input as { hostId: string }).hostId), ["mac"]);
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
  const scan = await experimental_scanPublicSdkOnly(fileURLToPath(new URL("..", import.meta.url)));
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
