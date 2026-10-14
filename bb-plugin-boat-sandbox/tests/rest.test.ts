import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Boat, BoatCommandError, createBody } from "../boat.js";
import { configSchema } from "../config.js";
import { BoatRest } from "../rest.js";
import type { RunResult } from "../process.js";

const signal = () => new AbortController().signal;
interface Call { method: string; path: string; headers: Record<string, string>; body?: unknown }
type Reply = { status: number; body: unknown } | Error;
// A scripted Boat API: each handler returns the response for one request.
function api(handler: (call: Call, calls: Call[]) => Reply) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? "GET",
      path: String(url).replace("https://boat.dev/api/v1", ""),
      headers: Object.fromEntries(Object.entries(init?.headers ?? {})),
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    };
    calls.push(call);
    const reply = handler(call, calls);
    if (reply instanceof Error) throw reply;
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, rest: new BoatRest("boat_secret_key", "personal", fetchImpl, 1) };
}
const noCli = async (): Promise<RunResult> => { throw new Error("the CLI must not be used"); };
const ok = (body: unknown): Reply => ({ status: 200, body: { ok: true, ...(body as object) } });
const failure = (status: number, code: string, message = "secret-bearing detail https://x.test/?token=t"): Reply => ({ status, body: { ok: false, type: "sandbox.error", status, code, message, error: { code, message, status } } });
const ready = ok({ sandbox: { id: "bx_new", state: "ready" } });

test("requests authenticate, bill to the scope and never leak error bodies", async () => {
  const { calls, rest } = api((call) => call.path === "/limits" ? failure(401, "unauthorized") : ok({ enabled: false, snapshotsOff: false }));
  const boat = new Boat("boat", "personal", noCli, rest);
  const error = await boat.preflight(signal()).then(() => null, (failed: unknown) => failed);
  assert.ok(error instanceof BoatCommandError);
  assert.equal(error.code, "unauthorized");
  assert.doesNotMatch(error.message, /secret-bearing|token/);
  const limits = calls.find((call) => call.path === "/limits")!;
  assert.equal(limits.headers.authorization, "Bearer boat_secret_key");
  assert.equal(limits.headers["x-boat-org"], "personal");
  // Retention is read for the configured scope, as the CLI's --org did.
  assert.equal(calls.find((call) => call.path === "/account/data-retention")!.headers["x-boat-org"], "personal");
});

test("the API identity hashes the account email like the CLI login", async () => {
  const email = "octocat@example.com";
  const { rest } = api(() => ok({ user: { id: "usr_1", email, accountStatus: "active" } }));
  const cli = async (_: string, args: string[]): Promise<RunResult> => {
    assert.equal(args[4], "status");
    return { exitCode: 0, stdout: JSON.stringify({ account: { identifier: email, loginState: "active" } }), stderr: "" };
  };
  const boat = new Boat("boat", "personal", cli, rest);
  assert.equal(await boat.accountIdentity(signal()), createHash("sha256").update(email).digest("hex"));
  assert.equal(await boat.verifiedAccountIdentity(signal()), createHash("sha256").update(email).digest("hex"));
  const other = new Boat("boat", "personal", async () => ({ exitCode: 0, stdout: JSON.stringify({ account: { identifier: "someone@else.test", loginState: "active" } }), stderr: "" }), rest);
  await assert.rejects(other.verifiedAccountIdentity(signal()), /different accounts/);
});

test("creation sends the allocation key as the idempotency key and retries until Boat returns the sandbox", async () => {
  const config = configSchema.parse({ snapshot: "my-stack" });
  let posts = 0;
  const { calls, rest } = api((call) => {
    if (call.method !== "POST") return ready;
    posts += 1;
    // A lost response, then the first request still creating, then the sandbox.
    if (posts === 1) return new TypeError("fetch failed");
    if (posts === 2) return failure(409, "idempotency_in_progress");
    return { status: 202, body: { ok: true, status: "provisioning", sandbox: { id: "bx_new", state: "provisioning" } } };
  });
  const saved: string[] = [];
  const boat = new Boat("boat", "personal", noCli, rest);
  assert.equal(await boat.create(config, "launch1", signal(), async (id) => { saved.push(id); }), "bx_new");
  assert.deepEqual(saved, ["bx_new"]);
  const creates = calls.filter((call) => call.method === "POST");
  assert.equal(creates.length, 3);
  for (const create of creates) {
    assert.equal(create.path, "/sandboxes");
    assert.equal(create.headers["idempotency-key"], "launch1");
    assert.equal(create.headers["x-boat-org"], "personal");
    assert.deepEqual(create.body, createBody(config, "launch1"));
  }
  assert.deepEqual(creates[0]!.body, { type: "default", ttlSeconds: 3600, environment: "base", env: { BB_BOAT_ALLOCATION_KEY: "launch1" }, from: "my-stack" });
});

test("a reused idempotency key is reported instead of creating another sandbox", async () => {
  const { rest } = api(() => failure(409, "idempotency_key_reused"));
  const boat = new Boat("boat", "personal", noCli, rest);
  await assert.rejects(boat.create(configSchema.parse({}), "launch1", signal(), async () => { throw new Error("must not allocate"); }), /different request/);
});

test("resume, extend and delete map to the API and Boat's error codes", async () => {
  let state = "archived";
  const { calls, rest } = api((call) => {
    if (call.path === "/sandboxes/bx_test/resume") { state = "ready"; return { status: 202, body: { ok: true } }; }
    if (call.method === "DELETE") return failure(404, "not_found");
    if (call.path === "/sandboxes/bx_test") return call.method === "PATCH" ? ok({}) : ok({ sandbox: { id: "bx_test", state, snapshotAvailable: true } });
    return ok({ enabled: false, canStart: true });
  });
  const boat = new Boat("boat", "personal", noCli, rest);
  await boat.resume("bx_test", 3600, signal());
  assert.deepEqual(calls.find((call) => call.path.endsWith("/resume"))!.body, { ttlSeconds: 3600 });
  assert.deepEqual(calls.find((call) => call.method === "PATCH")!.body, { ttlSeconds: 3600 });
  await boat.remove("bx_test", signal());
  assert.equal(calls.find((call) => call.method === "DELETE")!.headers["x-ascii-confirm-delete"], "bx_test");
  const expired = new Boat("boat", "personal", noCli, api((call) => call.path.endsWith("/resume")
    ? failure(409, "snapshot_data_expired")
    : ok({ sandbox: { id: "bx_test", state: "archived", snapshotAvailable: true }, enabled: false, canStart: true })).rest);
  await assert.rejects(expired.resume("bx_test", 3600, signal()), /asleep for more than 14 days/);
});

test("a stop Boat refuses is reported with its reason, without links", async () => {
  const { rest } = api((call) => {
    if (call.path === "/account/data-retention") return ok({ enabled: false });
    if (call.method === "POST") return { status: 202, body: { ok: true, sandbox: { id: "bx_test", state: "archiving" } } };
    return ok({ sandbox: { id: "bx_test", state: "archiving", stop: { id: "stop_1", status: "failing", error: "snapshot upload failed, see https://x.test/?token=t" } } });
  });
  const boat = new Boat("boat", "personal", async () => ({ exitCode: 0, stdout: "", stderr: "" }), rest);
  await assert.rejects(boat.stop("bx_test", signal()), (error: Error) => {
    assert.match(error.message, /Boat could not save bx_test \(snapshot upload failed, see \[link\]\)/);
    assert.doesNotMatch(error.message, /token/);
    return true;
  });
});

test("transient API failures are retried only for idempotent calls", async () => {
  let gets = 0;
  const { rest } = api((call) => {
    if (call.method === "GET") { gets += 1; return gets === 1 ? failure(503, "no_ready_machine") : ok({ sandbox: { id: "bx_test", state: "ready" } }); }
    return failure(503, "no_ready_machine");
  });
  const boat = new Boat("boat", "personal", noCli, rest);
  assert.equal((await boat.info("bx_test", signal())).state, "ready");
  await assert.rejects(rest.request("resume", "POST", "/sandboxes/bx_test/resume", { signal: signal(), body: {} }), (error: BoatCommandError) => error.code === "no_ready_machine");
});

test("a sandbox in error is power-cycled once through the API, and never resumed automatically", async () => {
  let state = "error";
  const { calls, rest } = api((call) => {
    if (call.path.endsWith("/recover")) { state = "ready"; return ok({}); }
    return ok({ sandbox: { id: "bx_test", state } });
  });
  const boat = new Boat("boat", "personal", noCli, rest);
  assert.equal((await boat.waitFor("bx_test", new Set(["ready"]), signal())).state, "ready");
  assert.equal(calls.filter((call) => call.path.endsWith("/recover")).length, 1);
  assert.ok(!calls.some((call) => call.path.endsWith("/resume")));
  // Boat cannot power-cycle it: report, keep the disk, do not resume.
  const stuck = new Boat("boat", "personal", noCli, api((call) => call.path.endsWith("/recover") ? failure(409, "recover_unsupported") : ok({ sandbox: { id: "bx_test", state: "error" } })).rest);
  await assert.rejects(stuck.waitFor("bx_test", new Set(["ready"]), signal()), /in error and did not recover after a power-cycle.*loses work written after its last snapshot/);
  const cli = new Boat("boat", "personal", async () => ({ exitCode: 0, stdout: JSON.stringify({ sandbox: { id: "bx_test", state: "error" } }), stderr: "" }));
  await assert.rejects(cli.waitFor("bx_test", new Set(["ready"]), signal()), /Try boat recover bx_test with a current Boat CLI/);
});

test("monitoring off is sent only when chosen, so older stored requests stay identical", () => {
  const on = createBody(configSchema.parse({}), "launch1");
  assert.ok(!("monitoring" in on));
  assert.equal(createBody({ ...configSchema.parse({}), monitoring: false }, "launch1").monitoring, false);
});

test("doctor reads whether the environment hands sandboxes a Boat API key", async () => {
  const { calls, rest } = api(() => ok({ environments: [{ name: "base", passSandboxCredentials: true }, { name: "locked", passSandboxCredentials: false }] }));
  const boat = new Boat("boat", "team_1", noCli, rest);
  assert.equal(await boat.passesBoatCredentials("base", signal()), true);
  assert.equal(await boat.passesBoatCredentials("locked", signal()), false);
  assert.equal(await boat.passesBoatCredentials("missing", signal()), null);
  // Environments select the organization by query parameter, not the header.
  assert.equal(calls[0]!.path, "/environments?org=team_1");
  assert.equal(await new Boat("boat", "personal", noCli).passesBoatCredentials("base", signal()), null);
});

test("an error while waiting for a stop is reported, not power-cycled back to running", async () => {
  const { calls, rest } = api(() => ok({ sandbox: { id: "bx_test", state: "error" } }));
  const boat = new Boat("boat", "personal", noCli, rest);
  await assert.rejects(boat.waitFor("bx_test", new Set(["archived", "stopped"]), signal()), /in error/);
  assert.ok(!calls.some((call) => call.path.endsWith("/recover")));
});

test("a resume whose response is lost waits for the resume Boat accepted", async () => {
  let state = "archived";
  const { rest } = api((call) => {
    if (call.path.endsWith("/resume")) { state = "ready"; return new TypeError("socket hang up"); }
    if (call.method === "PATCH") return ok({});
    return ok({ sandbox: { id: "bx_test", state, snapshotAvailable: true }, enabled: false, canStart: true });
  });
  await new Boat("boat", "personal", noCli, rest).resume("bx_test", 3600, signal());
  const never = api((call) => call.path.endsWith("/resume") ? new TypeError("socket hang up") : ok({ sandbox: { id: "bx_test", state: "archived", snapshotAvailable: true }, enabled: false, canStart: true }));
  await assert.rejects(new Boat("boat", "personal", noCli, never.rest).resume("bx_test", 3600, signal()), (error: BoatCommandError) => error.code === "network_error");
});

test("hosting failures through the API say what failed, and cancellation stays a cancellation", async () => {
  const boat = new Boat("boat", "personal", noCli, api(() => failure(400, "machine_not_running")).rest);
  await assert.rejects(boat.hostPreview("bx_test", 3000, signal()), /could not host port 3000 \(machine_not_running\)/);
  const controller = new AbortController();
  const slow = new Boat("boat", "personal", noCli, api(() => { controller.abort(new Error("share cancelled")); return new TypeError("aborted"); }).rest);
  await assert.rejects(slow.hostPreview("bx_test", 3000, controller.signal), /share cancelled/);
});

test("a stop that is not sent clears the hook marker so Boat's auto-stop runs the hook", async () => {
  const commands: string[] = [];
  const { rest } = api((call) => {
    if (call.path === "/account/data-retention") return ok({ enabled: false });
    if (call.path.endsWith("/commands")) { commands.push((call.body as { command: string }).command); return ok({ exitCode: 0, stdout: "" }); }
    if (call.path.endsWith("/stop")) return failure(402, "billing_required");
    return ok({ sandbox: { id: "bx_test", state: "ready" } });
  });
  const boat = new Boat("boat", "personal", async () => ({ exitCode: 0, stdout: "", stderr: "" }), rest);
  await assert.rejects(boat.stop("bx_test", signal()), (error: BoatCommandError) => error.code === "billing_required");
  assert.deepEqual(commands, ["rm -f $HOME/.cache/bb-boat/before-suspend.ran"]);
});
