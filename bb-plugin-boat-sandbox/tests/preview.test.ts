import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost, makeHostResponse, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { Boat } from "../boat.js";
import { previews, parsePreviewArgs } from "../preview.js";
import { createPlugin } from "../server.js";
import { configSchema, developmentDefaults } from "../config.js";

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

test("project development settings inherit defaults and can disable startup and fixed ports", () => {
  const config = configSchema.parse({ developmentCommand: "npm run dev", developmentPort: 5173,
    projectDevelopment: JSON.stringify({ project1: { command: "", port: 0, daemon: "web" } }) });
  assert.deepEqual(developmentDefaults(config, "project1"), { daemon: "web" });
  assert.deepEqual(developmentDefaults(config, "project2"), { command: "npm run dev", port: 5173, daemon: "rails" });
  for (const value of ['not json', '{"project1":{"port":65536}}', '{"project1":{"unknown":true}}']) {
    assert.equal(configSchema.safeParse({ projectDevelopment: value }).success, false);
  }
});

test("share uses project settings and lets CLI flags override them", async (t) => {
  const f = await fixture(); t.after(() => f.harness.lifecycle.dispose());
  f.harness.sdk.stub("threads.get", async () => makeThreadResponse({ id: "thread1", projectId: "project1", environmentId: "env1" }));
  await createPlugin(async () => f.boat)(f.bb);
  await f.harness.behavior.setSettings({ developmentPort: 4000,
    projectDevelopment: JSON.stringify({ project1: { command: "npm run custom", port: 8080 } }) });
  f.boat.ready = false;
  f.harness.sdk.stub("terminals.create", async (input: { start: unknown }) => {
    assert.deepEqual(input.start, { mode: "command", command: "npm run custom" });
    f.boat.ready = true;
    return { id: "term1" };
  });
  f.harness.sdk.stub("terminals.get", async () => ({ id: "term1", status: "running" }));
  const result = await f.harness.behavior.runCli(["share", "--thread", "thread1", "--json"]);
  assert.equal(result.exitCode, 0);
  assert.equal(JSON.parse(result.stdout!).port, 8080);
  const overridden = await f.harness.behavior.runCli(["share", "--thread", "thread1", "--port", "9090", "--json"]);
  assert.equal(overridden.exitCode, 0);
  assert.equal(JSON.parse(overridden.stdout!).port, 9090);
  assert.equal(f.harness.sdk.callsTo("terminals.create").length, 1);
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

test("share resolves the thread environment, targets its Boat host and opens the private URL in the thread's browser", async (t) => {
  const f = await fixture();
  const { harness } = f;
  await createPlugin(async () => f.boat)(f.bb);
  t.after(() => harness.lifecycle.dispose());
  const result = await harness.behavior.runCli(["share", "--thread", "thread1", "--json"]);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(f.boat.calls, ["host:3017"]);
  const payload = JSON.parse(result.stdout!);
  assert.equal(payload.url, secretUrl);
  assert.equal(payload.browser, "opened");
  assert.deepEqual(payload.browserTarget, { hostId: "mac", instanceId: "window" });
  const call = harness.sdk.callsTo("experimental_desktopBrowsers.createTab")[0]!;
  assert.match(JSON.stringify(call), /thread1/);
  assert.match(JSON.stringify(call), /_token=private-token/);
});

test("share accepts an arbitrary app port without project discovery or host RPC", async (t) => {
  const f = await fixture(); t.after(() => f.harness.lifecycle.dispose());
  f.boat.previewPort = async () => { throw new Error("must not inspect project tooling"); };
  await createPlugin(async () => f.boat)(f.bb);
  const result = await f.harness.behavior.runCli(["share", "--thread", "thread1", "--port", "8080", "--json"]);
  assert.equal(result.exitCode, 0);
  assert.equal(JSON.parse(result.stdout!).port, 8080);
  assert.deepEqual(f.boat.calls, ["host:8080"]);
  assert.equal(f.harness.inspection.experimental_hostRpcCalls.length, 0);
  assert.equal(f.harness.sdk.callsTo("terminals.create").length, 0);
  f.boat.ready = false;
  const stopped = await f.harness.behavior.runCli(["share", "--thread", "thread1", "--port", "8080"]);
  assert.equal(stopped.exitCode, 1);
  assert.equal(f.harness.sdk.callsTo("terminals.create").length, 0);
});

test("share starts only the explicit app command in a thread terminal", async (t) => {
  const f = await fixture(); t.after(() => f.harness.lifecycle.dispose());
  f.boat.ready = false;
  const command = "python3 -m http.server 8080 --bind 0.0.0.0";
  f.harness.sdk.stub("terminals.create", async (input: { start: unknown }) => {
    assert.deepEqual(input.start, { mode: "command", command });
    f.boat.ready = true;
    return { id: "term1" };
  });
  f.harness.sdk.stub("terminals.get", async () => ({ id: "term1", status: "running" }));
  await createPlugin(async () => f.boat)(f.bb);
  const args = ["share", "--thread", "thread1", "--port", "8080", "--command", command, "--json"];
  const result = await f.harness.behavior.runCli(args);
  assert.equal(result.exitCode, 0);
  assert.equal(JSON.parse(result.stdout!).terminalId, "term1");
  assert.equal((await f.harness.behavior.runCli(args)).exitCode, 0);
  assert.equal(f.harness.sdk.callsTo("terminals.create").length, 1);
});

test("share withholds tokens by default and requires explicit URL output", async (t) => {
  const f = await fixture();
  const { harness } = f;
  await createPlugin(async () => f.boat)(f.bb);
  t.after(() => harness.lifecycle.dispose());
  const plain = await harness.behavior.runCli(["share", "--thread", "thread1"]);
  assert.equal(plain.exitCode, 0);
  assert.match(plain.stdout!, /https:\/\/app-3017.on.boat.dev/);
  assert.match(plain.stdout!, /withheld/);
  assert.doesNotMatch(JSON.stringify(plain), /_token|private-token/);
  const explicit = await harness.behavior.runCli(["share", "--url", "--thread", "thread1"]);
  assert.equal(explicit.exitCode, 0);
  assert.equal(explicit.stdout, secretUrl);
});

test("share reports no target when the selected Boat host has no desktop", async (t) => {
  const f = await fixture();
  const { harness } = f;
  await createPlugin(async () => f.boat)(f.bb);
  t.after(() => harness.lifecycle.dispose());
  const payload = JSON.parse((await harness.behavior.runCli(["share", "--thread", "thread1", "--browser-host", "sandbox", "--json"])).stdout!);
  assert.equal(payload.browser, "unavailable");
  assert.equal(payload.browserTarget, null);
  assert.match(payload.message, /0 desktop windows matched/);
  assert.equal(harness.sdk.callsTo("experimental_desktopBrowsers.createTab").length, 0);
  const plain = await harness.behavior.runCli(["share", "--thread", "thread1", "--browser-host", "sandbox"]);
  assert.doesNotMatch(JSON.stringify(plain), /_token|private-token/);
  assert.match(plain.stdout!, /withheld/);
});

test("share does not report a browser target when the desktop operation fails", async (t) => {
  const f = await fixture();
  const { harness } = f;
  await createPlugin(async () => f.boat)(f.bb);
  t.after(() => harness.lifecycle.dispose());
  harness.sdk.stub("experimental_desktopBrowsers.createTab", async () => { throw new Error("desktop disconnected"); });
  const payload = JSON.parse((await harness.behavior.runCli(["share", "--thread", "thread1", "--json"])).stdout!);
  assert.equal(payload.browser, "unavailable");
  assert.equal(payload.browserTarget, null);
});

test("share reveals a tab already on the shared origin instead of duplicating it", async (t) => {
  const f = await fixture();
  const { harness } = f;
  await createPlugin(async () => f.boat)(f.bb);
  t.after(() => harness.lifecycle.dispose());
  // The app strips the token on redirect, so the open tab no longer carries it.
  harness.sdk.stub("experimental_desktopBrowsers.listTabs", async () => ({ tabs: [{ tabId: "existing", url: "https://app-3017.on.boat.dev/users/login" }] }));
  harness.sdk.stub("experimental_desktopBrowsers.revealTab", async () => ({ ok: true }));
  const payload = JSON.parse((await harness.behavior.runCli(["share", "--thread", "thread1", "--json"])).stdout!);
  assert.equal(payload.browser, "reused");
  assert.equal(payload.url, secretUrl);
  assert.equal(harness.sdk.callsTo("experimental_desktopBrowsers.createTab").length, 0);
});

test("share still returns the private link when no single desktop window can be chosen", async (t) => {
  const f = await fixture();
  const { harness } = f;
  await createPlugin(async () => f.boat)(f.bb);
  t.after(() => harness.lifecycle.dispose());
  harness.sdk.stub("experimental_desktopBrowsers.listInstances", async () => ({ instances: [{ hostId: "mac", instanceId: "one", generation: "current" }, { hostId: "mac", instanceId: "two", generation: "current" }] }));
  const many = JSON.parse((await harness.behavior.runCli(["share", "--thread", "thread1", "--json"])).stdout!);
  assert.equal(many.browser, "unavailable");
  assert.equal(many.url, secretUrl);
  assert.match(many.message, /--browser-instance/);
  harness.sdk.stub("hosts.list", async () => { throw new Error("offline"); });
  const offline = JSON.parse((await harness.behavior.runCli(["share", "--thread", "thread1", "--json"])).stdout!);
  assert.equal(offline.browser, "unavailable");
  assert.equal(offline.url, secretUrl);
  assert.doesNotMatch(offline.message, /--browser-instance/);
});

test("share passes an explicit desktop window through to the browser lookup", async (t) => {
  const f = await fixture();
  const { harness } = f;
  await createPlugin(async () => f.boat)(f.bb);
  t.after(() => harness.lifecycle.dispose());
  const result = await harness.behavior.runCli(["share", "--thread", "thread1", "--browser-host", "mac", "--browser-instance", "window", "--json"]);
  assert.equal(JSON.parse(result.stdout!).browser, "opened");
  assert.deepEqual(harness.sdk.callsTo("experimental_desktopBrowsers.listInstances").map(([input]) => (input as { hostId: string }).hostId), ["mac"]);
});

test("UI sharing respects project defaults without opening a server-side desktop or storing tokens", async (t) => {
  const f = await fixture(); t.after(() => f.harness.lifecycle.dispose());
  f.harness.sdk.stub("threads.get", async () => makeThreadResponse({ id: "thread1", projectId: "project1", environmentId: "env1" }));
  await createPlugin(async () => f.boat)(f.bb);
  await f.harness.behavior.setSettings({ developmentPort: 4000, projectDevelopment: JSON.stringify({ project1: { port: 8080 } }) });
  assert.deepEqual(await f.harness.behavior.callRpc("share", { threadId: "thread1" }), { url: secretUrl, origin: "https://app-3017.on.boat.dev" });
  assert.deepEqual(f.boat.calls, ["host:8080"]);
  assert.equal(f.harness.sdk.callsTo("experimental_desktopBrowsers.listInstances").length, 0);
  assert.equal(f.harness.sdk.callsTo("experimental_desktopBrowsers.createTab").length, 0);
  for (const key of await f.bb.storage.kv.list()) assert.doesNotMatch(JSON.stringify(await f.bb.storage.kv.get(key)), /private-token/);
  f.host.machineProviderId = "other";
  await assert.rejects(f.harness.behavior.callRpc("share", { threadId: "thread1" }), /not on a Boat/);
});
