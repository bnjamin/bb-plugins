import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Boat, BoatCommandError } from "../boat.js";
import { configSchema } from "../config.js";
import { run, shellQuote, type Runner, type RunResult } from "../process.js";

const signal = () => new AbortController().signal;
const ok = (data: unknown): RunResult => ({ exitCode: 0, stdout: JSON.stringify(data), stderr: "" });

test("allocation is saved on the first created event, including readiness failure", async () => {
  const saved: string[] = [];
  const runner: Runner = async (_, args, options) => {
    assert.deepEqual(args.slice(0, 4), ["--no-update", "--org", "personal", "--json"]);
    if (args[4] === "new") {
      assert.ok(args.includes("BB_BOAT_ALLOCATION_KEY=launch1"));
      await options.onLine!(JSON.stringify({ event: "created", id: "bx_test" }));
      assert.deepEqual(saved, ["bx_test"]);
      return { exitCode: 1, stdout: '{"event":"error","error":"readiness command did not succeed"}', stderr: "" };
    }
    return ok({ sandbox: { id: "bx_test", state: "ready", desktopUrl: "secret-url" } });
  };
  const boat = new Boat("boat", "personal", runner);
  assert.equal(await boat.create(configSchema.parse({}), "launch1", signal(), async (id) => { saved.push(id); }), "bx_test");
  assert.deepEqual(await boat.info("bx_test", signal()), { id: "bx_test", state: "ready" });
});

test("a lost create response adopts the one new sandbox carrying this allocation key", async () => {
  const saved: string[] = [];
  const operations: string[] = [];
  const recent = new Date().toISOString();
  const old = new Date(Date.now() - 3_600_000).toISOString();
  const boat = new Boat("boat", "personal", async (_, args) => {
    operations.push(args[4]!);
    switch (args[4]) {
      case "new": return { exitCode: 1, stdout: '{"event":"error","error":"could not reach the Boat API: operation timed out"}', stderr: "" };
      case "list": return ok({ sandboxes: [
        { id: "bx_old", state: "ready", createdAt: old },
        { id: "bx_other", state: "ready", createdAt: recent },
        { id: "bx_mine", state: "ready", createdAt: recent },
      ] });
      case "exec": return ok({ exitCode: 0, stdout: args[5] === "bx_mine" ? "launch1\n" : "someone-else\n" });
      default: return ok({ sandbox: { id: args[5], state: "ready" } });
    }
  });
  assert.equal(await boat.create(configSchema.parse({}), "launch1", signal(), async (id) => { saved.push(id); }), "bx_mine");
  assert.deepEqual(saved, ["bx_mine"]);
  assert.ok(!operations.includes("delete"));
  // Nothing new appeared: the original failure is reported and nothing is adopted.
  const none = new Boat("boat", "personal", async (_, args) => args[4] === "new"
    ? { exitCode: 1, stdout: '{"event":"error","error":"operation timed out"}', stderr: "" }
    : ok({ sandboxes: [{ id: "bx_old", state: "ready", createdAt: old }] }));
  await assert.rejects(none.create(configSchema.parse({}), "launch1", signal(), async () => { throw new Error("must not allocate"); }), BoatCommandError);
});

test("failure after allocation remains a failure and does not expose raw output", async () => {
  let saved = false;
  const boat = new Boat("boat", "personal", async (_, __, options) => {
    await options.onLine!('{"event":"created","id":"bx_test"}');
    return { exitCode: 1, stdout: "credential-value", stderr: "signed-secret-url" };
  });
  await assert.rejects(boat.create(configSchema.parse({}), "key", signal(), async () => { saved = true; }), (error: Error) => {
    assert.ok(error instanceof BoatCommandError);
    assert.doesNotMatch(error.message, /credential-value|signed-secret-url/);
    return true;
  });
  assert.ok(saved);
});

test("delete accepts confirmed absence but retries auth and transport failures", async () => {
  const missing = new Boat("boat", "personal", async () => ({ exitCode: 1, stdout: '{"event":"error","code":"not_found","status":404}', stderr: "" }));
  await missing.remove("bx_missing", signal());
  for (const code of ["unauthorized", "network_error"]) {
    const boat = new Boat("boat", "personal", async () => ({ exitCode: 1, stdout: JSON.stringify({ code }), stderr: "" }));
    await assert.rejects(boat.remove("bx_test", signal()));
  }
});

test("sleep is idempotent, requires a snapshot, and refuses delete-on-stop", async () => {
  const operations: string[] = [];
  let enabled = false, snapshot = true;
  const boat = new Boat("boat", "team_original", async (_, args) => {
    operations.push(args[4]!);
    if (args[4] === "data-retention") return ok({ enabled });
    return ok({ sandbox: { id: "bx_test", state: "archived", snapshotAvailable: snapshot } });
  });
  await boat.stop("bx_test", signal());
  assert.ok(!operations.includes("stop"));
  snapshot = false;
  await assert.rejects(boat.stop("bx_test", signal()), /without a confirmed snapshot/);
  enabled = true;
  await assert.rejects(boat.stop("bx_test", signal()), /delete-on-stop/);
});

test("resume reuses running compute and refuses missing snapshots", async () => {
  const operations: string[] = [];
  let state = "ready";
  const boat = new Boat("boat", "personal", async (_, args) => {
    operations.push(args[4]!);
    return args[4] === "info" ? ok({ sandbox: { id: "bx_test", state, snapshotAvailable: false } }) : ok({});
  });
  await boat.resume("bx_test", 3600, signal());
  assert.deepEqual(operations, ["info", "extend"]);
  state = "archived";
  await assert.rejects(boat.resume("bx_test", 3600, signal()), /no recoverable snapshot/);
  assert.ok(!operations.includes("new"));
});

test("a failing database shutdown hook prevents snapshotting and hides its output", async () => {
  const operations: string[] = [];
  const boat = new Boat("boat", "personal", async (_, args, options) => {
    operations.push(args[4]!);
    if (args[4] === "data-retention") return ok({ enabled: false });
    if (args[4] === "info") return ok({ sandbox: { id: "bx_test", state: "ready" } });
    assert.match(options.stdin!, /before-suspend/);
    return { exitCode: 1, stdout: "private-config", stderr: "database shutdown failed" };
  });
  await assert.rejects(boat.stop("bx_test", signal()), /Boat before-suspend hook failed/);
  assert.deepEqual(operations, ["data-retention", "info", "ssh"]);
});

test("database shutdown completes before Boat saves the snapshot", async () => {
  const operations: string[] = [];
  let stopped = false;
  const boat = new Boat("boat", "personal", async (_, args) => {
    operations.push(args[4]!);
    if (args[4] === "data-retention") return ok({ enabled: false });
    if (args[4] === "stop") stopped = true;
    if (args[4] === "info") return ok({ sandbox: { id: "bx_test", state: stopped ? "stopped" : "ready", snapshotAvailable: stopped } });
    return ok({});
  });
  await boat.stop("bx_test", signal());
  assert.deepEqual(operations, ["data-retention", "info", "ssh", "stop", "info"]);
});

test("executor passes enrollment only on stdin and quotes every argv element", async () => {
  const boat = new Boat("boat", "personal", async (_, args, options) => {
    assert.ok(!args.join(" ").includes("private-enrollment"));
    assert.equal(args.at(-1), "'bash' '-c' 'printf '\\''hello'\\'''" );
    assert.equal(options.stdin, "private-enrollment");
    return ok({});
  });
  await boat.executor("bx_test").exec({ command: ["bash", "-c", "printf 'hello'"], stdin: "private-enrollment", timeoutMs: 1000, signal: signal(), onOutput: () => {} });
});

test("shell quoting round-trips metacharacters without executing them", async () => {
  const value = "hello ' $(touch /tmp/bb-boat-should-not-exist) `echo bad`\nsecond";
  const result = await run("/bin/sh", ["-c", `printf %s ${shellQuote(value)}`], { signal: signal() });
  assert.equal(result.stdout, value);
});

test("process cancellation, timeout, output bound and private stdin", async () => {
  let logged = "";
  const echo = await run(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], { signal: signal(), stdin: "credential", onOutput: (chunk) => { logged += chunk; } });
  assert.equal(echo.stdout, "credential");
  assert.equal(logged, "");
  await assert.rejects(run(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], { signal: signal(), timeoutMs: 40 }), /timed out/);
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await assert.rejects(run(process.execPath, [], { signal: controller.signal }), /cancelled/);
  await assert.rejects(run(process.execPath, ["-e", "process.stdout.write('x'.repeat(3*1024*1024))"], { signal: signal() }), /output limit/);
});

test("preparation waits for the ascii-lazyfs mount SOURCE before renaming directories", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bb-boat-mount-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  await mkdir(bin);
  // lazyfs identifies itself through SOURCE; FSTYPE is only fuse.
  await writeFile(join(bin, "findmnt"), `#!/bin/sh
printf '%s\\n' "$*" >> "$HOME/findmnt-calls"
case "$*" in
  *SOURCE*)
    if [ ! -e "$HOME/hydrated" ]; then
      touch "$HOME/hydrated"
      printf 'ascii-lazyfs\\n'
    else printf '/dev/vda1[/home]\\n'; fi ;;
  *) printf 'fuse\\n' ;;
esac
`, { mode: 0o755 });
  await writeFile(join(bin, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await writeFile(join(bin, "sysctl"), "#!/bin/sh\necho 1\n", { mode: 0o755 });
  await writeFile(join(bin, "id"), "#!/bin/sh\necho 1000\n", { mode: 0o755 });
  await writeFile(join(bin, "sudo"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$HOME/userns-calls"\n', { mode: 0o755 });
  await mkdir(join(root, ".config/bb-boat"), { recursive: true });
  await writeFile(join(root, ".config/bb-boat/prepare"), 'test -f "$HOME/hydrated" && touch "$HOME/database-ready"\n');
  const boat = new Boat("boat", "personal", async (_, __, options) => {
    const result = spawnSync("bash", ["-s"], {
      input: options.stdin, encoding: "utf8", timeout: 5000,
      env: { ...process.env, HOME: root, PATH: `${bin}:${process.env.PATH}` },
    });
    if (result.error) throw result.error;
    return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
  });
  const progress: string[] = [];
  const report = { step: (text: string) => progress.push(`step:${text}`), log: (text: string) => progress.push(`log:${text}`) };
  await boat.prepare("bx_test", signal(), report);
  const usernsCalls = await readFile(join(root, "userns-calls"), "utf8");
  assert.match(usernsCalls, /-n sh -ec/);
  assert.match(usernsCalls, /kernel.apparmor_restrict_unprivileged_userns=0/);
  assert.match(usernsCalls, /sysctl -q -p \/etc\/sysctl.d\/99-bb-boat-userns.conf/);
  const calls = (await readFile(join(root, "findmnt-calls"), "utf8")).trim().split("\n");
  assert.equal(calls.length, 2, "must observe lazyfs and then wait until it is replaced");
  assert.ok(calls.every((call) => call.includes("SOURCE")));
  assert.equal(await readFile(join(root, "database-ready"), "utf8"), "");
  // One SSH session covers the guard and the hook; only the timing line is read back.
  assert.equal(progress[0], "step:Waiting for the Boat filesystem and checking tools");
  assert.match(progress[1]!, /^log:Boat filesystem ready after \d+s; template prepare hook took \d+s\.\n$/);
  assert.equal(progress.length, 2);
  await writeFile(join(bin, "sudo"), '#!/bin/sh\necho "Operation not permitted" >&2\nexit 1\n', { mode: 0o755 });
  await assert.rejects(boat.prepare("bx_test", signal()), /Boat user namespace preparation failed/);
  // Kernels without Ubuntu's restriction need no elevated command.
  await writeFile(join(bin, "sysctl"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  await boat.prepare("bx_test", signal());
  await writeFile(join(root, ".config/bb-boat/prepare"), "echo private-hook-output\nexit 1\n");
  await assert.rejects(boat.prepare("bx_test", signal()), (error: Error) => {
    assert.match(error.message, /Boat prepare hook failed/);
    assert.doesNotMatch(error.message, /private-hook-output/);
    return true;
  });
  // A guard failure is reported as preparation, not as the hook.
  await writeFile(join(bin, "node"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  await assert.rejects(boat.prepare("bx_test", signal()), /Boat preparation failed/);
});
