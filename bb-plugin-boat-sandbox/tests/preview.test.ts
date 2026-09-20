import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost, makeHostResponse, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { Boat } from "../boat.js";
import { previews, parsePreviewArgs } from "../preview.js";
import { createPlugin } from "../server.js";

const secretUrl = "https://app-3017.on.boat.dev/?_token=private-token";
const resource = { version: 1, key: "launch1", scope: "personal", accountIdentity: "account1", sandboxId: "bx_test", ttlSeconds: 3600 };
class FakeBoat extends Boat {
  port: number | null = 3017;
  ready = true;
  existing = false;
  calls: string[] = [];
  account = "account1";
  constructor() { super("boat", "personal"); }
  override async accountIdentity() { return this.account; }
  override async previewPort(_: string, cwd: string) { assert.equal(cwd, "/remote/project"); return this.port; }
  override async portReady() { return this.ready; }
  override async hostedPort() { return this.existing; }
  override async hostPreview(_: string, port: number) { this.calls.push(`host:${port}`); return secretUrl; }
  override async hidePreview(_: string, port: number) { this.calls.push(`hide:${port}`); }
}
async function fixture() {
  const boat = new FakeBoat();
  const host = makeHostResponse({ id: "sandbox", status: "connected", machineProviderId: "boat-sandbox", lifecycle: { phase: "active", message: null, pendingLog: "", suspendedAt: null, teardown: null } });
  const desktopHost = makeHostResponse({ id: "mac", status: "connected" });
  const { bb, harness } = createFakePluginHost({ pluginId: "boat-sandbox", machineResource: async () => resource });
  harness.sdk.stub("threads.get", async () => makeThreadResponse({ id: "thread1", environmentId: "env1" }));
  harness.sdk.stub("environments.get", async () => ({ id: "env1", hostId: "sandbox", path: "/remote/project" }));
  harness.sdk.stub("hosts.get", async () => host);
  harness.sdk.stub("hosts.list", async () => [host, desktopHost]);
  harness.sdk.stub("experimental_desktopBrowsers.listInstances", async (input: { hostId: string }) => ({ instances: input.hostId === "mac" ? [{ hostId: "mac", instanceId: "window", generation: "current" }] : [] }));
  harness.sdk.stub("experimental_desktopBrowsers.listTabs", async () => ({ tabs: [] }));
  harness.sdk.stub("experimental_desktopBrowsers.createTab", async () => ({ tab: { tabId: "tab1" } }));
  const manager = previews(bb, async () => boat, new AbortController().signal);
  return { boat, bb, harness, manager, host };
}

test("opens the bumped port in the thread browser without exposing its token in CLI output or storage", async (t) => {
  const f = await fixture(); t.after(() => f.harness.lifecycle.dispose());
  const result = await f.manager.open({ threadId: "thread1" });
  assert.equal(result.port, 3017); assert.equal(result.browser, "opened");
  assert.doesNotMatch(JSON.stringify(result), /private-token/);
  const call = f.harness.sdk.callsTo("experimental_desktopBrowsers.createTab")[0]!;
  assert.match(JSON.stringify(call), /thread1/); assert.match(JSON.stringify(call), /private-token/);
  for (const key of await f.bb.storage.kv.list()) assert.doesNotMatch(JSON.stringify(await f.bb.storage.kv.get(key)), /private-token/);
});

test("returns the sharing URL only on explicit request and reuses the thread's existing tab", async (t) => {
  const f = await fixture(); t.after(() => f.harness.lifecycle.dispose());
  f.harness.sdk.stub("experimental_desktopBrowsers.listTabs", async () => ({ tabs: [{ tabId: "existing", url: "https://app-3017.on.boat.dev/users/login" }] }));
  f.harness.sdk.stub("experimental_desktopBrowsers.revealTab", async () => ({ ok: true }));
  const result = await f.manager.open({ threadId: "thread1", includeUrl: true });
  assert.equal(result.url, secretUrl); assert.equal(result.browser, "reused");
  assert.equal(f.harness.sdk.callsTo("experimental_desktopBrowsers.createTab").length, 0);
});

test("does not guess among desktop windows and keeps a ready route if browser access fails", async (t) => {
  const f = await fixture(); t.after(() => f.harness.lifecycle.dispose());
  f.harness.sdk.stub("experimental_desktopBrowsers.listInstances", async () => ({ instances: [] }));
  assert.equal((await f.manager.open({ threadId: "thread1" })).browser, "unavailable");
  f.harness.sdk.stub("hosts.list", async () => { throw new Error("offline"); });
  assert.equal((await f.manager.open({ threadId: "thread1" })).browser, "unavailable");
});

test("cleanup hides only plugin-owned routes after the app stops", async (t) => {
  const f = await fixture(); t.after(() => f.harness.lifecycle.dispose());
  await f.manager.open({ threadId: "thread1" });
  await f.manager.reconcile(); assert.deepEqual(f.boat.calls, ["host:3017"]);
  f.boat.ready = false; await f.manager.reconcile();
  assert.deepEqual(f.boat.calls, ["host:3017", "hide:3017"]);
  assert.equal((await f.bb.storage.kv.list("preview/")).length, 0);
});

test("cleanup and preview-stop preserve pre-existing routes", async (t) => {
  const f = await fixture(); t.after(() => f.harness.lifecycle.dispose()); f.boat.existing = true;
  await f.manager.open({ threadId: "thread1" }); f.boat.ready = false;
  await f.manager.reconcile(); await f.manager.stop("thread1");
  assert.deepEqual(f.boat.calls, ["host:3017"]);
});

test("rejects wrong machines, changed accounts and invalid ports before hosting", async (t) => {
  const f = await fixture(); t.after(() => f.harness.lifecycle.dispose());
  f.boat.account = "other";
  await assert.rejects(f.manager.open({ threadId: "thread1" }), /login changed/);
  f.host.machineProviderId = "other";
  await assert.rejects(f.manager.open({ threadId: "thread1" }), /not on a Boat/);
  assert.deepEqual(f.boat.calls, []);
  assert.throws(() => parsePreviewArgs(["--port", "0"], "thread1"), /Invalid/);
  assert.throws(() => parsePreviewArgs(["--command", "echo hello"], "thread1"), /requires/);
  assert.throws(() => parsePreviewArgs([], undefined), /--thread/);
});

test("dev uses a BB thread terminal and waits for the actual port; repeated starts reuse a ready app", async (t) => {
  const f = await fixture(); t.after(() => f.harness.lifecycle.dispose()); f.boat.port = null;
  f.harness.sdk.stub("terminals.create", async (input: { scope: unknown; start: unknown }) => {
    assert.deepEqual(input.scope, { kind: "thread", threadId: "thread1" });
    assert.deepEqual(input.start, { mode: "command", command: "mise run dev" });
    f.boat.port = 3017; return { id: "term1" };
  });
  f.harness.sdk.stub("terminals.get", async () => ({ id: "term1", status: "running" }));
  const result = await f.manager.open({ threadId: "thread1", start: true });
  assert.equal(result.terminalId, "term1");
  await f.manager.open({ threadId: "thread1", start: true });
  assert.equal(f.harness.sdk.callsTo("terminals.create").length, 1);
});

test("early terminal exit leaves logs available and never exposes an unready app", async (t) => {
  const f = await fixture(); t.after(() => f.harness.lifecycle.dispose()); f.boat.port = null;
  f.harness.sdk.stub("terminals.create", async () => ({ id: "term1" }));
  f.harness.sdk.stub("terminals.get", async () => ({ id: "term1", status: "exited" }));
  await assert.rejects(f.manager.open({ threadId: "thread1", start: true }), /Inspect terminal term1/);
  assert.deepEqual(f.boat.calls, []);
  assert.equal(f.harness.sdk.callsTo("terminals.close").length, 0);
});

test("registered CLI accepts explicit thread context and hides private URL by default", async (t) => {
  const f = await fixture(); t.after(() => f.harness.lifecycle.dispose());
  await createPlugin(async () => f.boat)(f.bb);
  const result = await f.harness.behavior.runCli(["preview", "--thread", "thread1", "--json"]);
  assert.equal(result.exitCode, 0); assert.doesNotMatch(result.stdout!, /private-token/);
});

test("Boat preview transport validates protected hostnames and never echoes malformed private responses", async () => {
  for (const data of [
    { url: "https://app-3000.on.boat.dev?_token=secret", isProtected: false },
    { url: "https://other.example/?_token=secret", isProtected: true },
    { url: "http://app-3000.on.boat.dev?_token=secret", isProtected: true },
    { url: "https://app-3000.on.boat.dev", isProtected: true },
  ]) {
    const boat = new Boat("boat", "personal", async () => ({ exitCode: 0, stdout: JSON.stringify(data), stderr: "" }));
    await assert.rejects(boat.hostPreview("bx_test", 3000, new AbortController().signal), (e: Error) => {
      assert.doesNotMatch(e.message, /secret|other.example/); return true;
    });
  }
  const boat = new Boat("boat", "personal", async (_, args) => {
    assert.deepEqual(args.slice(4), ["host", "bx_test", "3017", "--private", "--title", "BB app preview"]);
    return { exitCode: 0, stdout: JSON.stringify({ url: secretUrl, isProtected: true }), stderr: "" };
  });
  assert.equal(await boat.hostPreview("bx_test", 3017, new AbortController().signal), secretUrl);
});

test("Boat status discovery parses assigned ports and treats down routes as unowned", async () => {
  const requests: string[] = [];
  const boat = new Boat("boat", "personal", async (_, args) => {
    requests.push(args.at(-1)!);
    const stdout = args.at(-1) === "host list" ? "3017 https://app-3017.on.boat.dev (gated) (down) App" : JSON.stringify({ status: "running", port: [3017] });
    return { exitCode: 0, stdout: JSON.stringify({ exitCode: 0, stdout }), stderr: "" };
  });
  const signal = new AbortController().signal;
  assert.equal(await boat.previewPort("bx_test", "/project with spaces", "rails", signal), 3017);
  assert.equal(await boat.hostedPort("bx_test", 3017, signal), false);
  assert.match(requests[0]!, /cd '\/project with spaces'/);
});
