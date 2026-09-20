import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import hostEntry, { mergeDevelopmentEnv, safeStderrHint } from "../host.js";

test("the stderr hint prefers the real error over a generic verbosity footer", () => {
  assert.equal(
    safeStderrHint("mise ERROR supervisor is not running\n\nmise ERROR Run with --verbose or MISE_VERBOSE=1 for more information\n"),
    "mise ERROR supervisor is not running",
  );
  assert.equal(safeStderrHint("first\nsecond\nthird\nfourth\n"), "second | third | fourth");
  assert.equal(safeStderrHint("   \n\n"), undefined);
});

test("development environment repair preserves other settings and is idempotent", () => {
  const current = "DATABASE_URL=postgres://example\nHOST=127.0.0.1\nASSUME_SSL=0\n";
  const repaired = mergeDevelopmentEnv(current);
  assert.equal(repaired, "DATABASE_URL=postgres://example\nHOST=0.0.0.0\nASSUME_SSL=0\n");
  assert.equal(mergeDevelopmentEnv(repaired), repaired);
  assert.equal(mergeDevelopmentEnv("A=1\n"), "A=1\nHOST=0.0.0.0\n");
});

test("host share repairs Sofia, starts it detached, and returns only the private URL", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bb-boat-share-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const bin = join(root, "bin");
  await mkdir(join(root, "script"), { recursive: true });
  await mkdir(bin);
  await writeFile(join(root, "mise.toml"), "[daemons]\nrails = {}\njs = {}\ncss = {}\n");
  await writeFile(join(root, "script/dev-start.rb"), "# test\n");
  await writeFile(join(root, ".env.development"), "KEEP=this\nHOST=127.0.0.1\n");
  // A clean workspace has no supervisor to stop, so the pre-stop exits non-zero.
  await writeFile(join(bin, "mise"), "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$PWD/calls\"\necho 'mise ERROR supervisor is not running' >&2\nexit 1\n", { mode: 0o755 });
  await writeFile(join(bin, "ruby"), "#!/bin/sh\nnode \"$BB_SHARE_TEST_SERVER\" \"$BB_SHARE_TEST_PORT\" >/dev/null 2>&1 &\n", { mode: 0o755 });
  await writeFile(join(bin, "host"), "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$PWD/calls\"\nif [ \"$1\" = url ]; then printf '%s\\n' 'https://sofia.on.boat.dev/?_token=secret'; fi\n", { mode: 0o755 });
  await Promise.all(["mise", "ruby", "host"].map((name) => chmod(join(bin, name), 0o755)));
  const previousPath = process.env.PATH;
  const previousBoat = process.env.BOAT_ID;
  const previousPort = process.env.BB_SHARE_TEST_PORT;
  const previousServer = process.env.BB_SHARE_TEST_SERVER;
  const previousHost = process.env.BB_BOAT_SHARE_HOST_BINARY;
  process.env.PATH = `${bin}:${previousPath}`;
  process.env.BOAT_ID = "bx_test";
  process.env.BB_SHARE_TEST_PORT = "38123";
  process.env.BB_SHARE_TEST_SERVER = join(process.cwd(), "tests", "host-server.mjs");
  process.env.BB_BOAT_SHARE_HOST_BINARY = join(bin, "host");
  t.after(() => {
    process.env.PATH = previousPath;
    if (previousBoat === undefined) delete process.env.BOAT_ID; else process.env.BOAT_ID = previousBoat;
    if (previousPort === undefined) delete process.env.BB_SHARE_TEST_PORT; else process.env.BB_SHARE_TEST_PORT = previousPort;
    if (previousServer === undefined) delete process.env.BB_SHARE_TEST_SERVER; else process.env.BB_SHARE_TEST_SERVER = previousServer;
    if (previousHost === undefined) delete process.env.BB_BOAT_SHARE_HOST_BINARY; else process.env.BB_BOAT_SHARE_HOST_BINARY = previousHost;
  });
  const harness = experimental_createHostEntryHarness(hostEntry);
  t.after(() => harness.experimental_dispose());
  assert.deepEqual(await harness.experimental_call("share", { workspacePath: root, port: 38123 }), { url: "https://sofia.on.boat.dev/?_token=secret" });
  assert.equal(await readFile(join(root, ".env.development"), "utf8"), "KEEP=this\nHOST=0.0.0.0\n");
  assert.deepEqual((await readFile(join(root, "calls"), "utf8")).trim().split("\n"), [
    "daemons stop", "38123 --private --title BB Sofia development", "url 38123 --private",
  ]);
});

test("a failing host command reports its exit code and last stderr line without leaking the token", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bb-boat-share-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const bin = join(root, "bin");
  await mkdir(join(root, "script"), { recursive: true });
  await mkdir(bin);
  await writeFile(join(root, "mise.toml"), "[daemons]\nrails = {}\njs = {}\ncss = {}\n");
  await writeFile(join(root, "script/dev-start.rb"), "# test\n");
  await writeFile(join(bin, "mise"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await writeFile(join(bin, "ruby"), "#!/bin/sh\nnode \"$BB_SHARE_TEST_SERVER\" \"$BB_SHARE_TEST_PORT\" >/dev/null 2>&1 &\n", { mode: 0o755 });
  await writeFile(join(bin, "host"), "#!/bin/sh\necho 'Error: ASCII_TOKEN=sk-live-secret is not set' >&2\nexit 3\n", { mode: 0o755 });
  await Promise.all(["mise", "ruby", "host"].map((name) => chmod(join(bin, name), 0o755)));
  const previous = { path: process.env.PATH, port: process.env.BB_SHARE_TEST_PORT, server: process.env.BB_SHARE_TEST_SERVER, host: process.env.BB_BOAT_SHARE_HOST_BINARY };
  process.env.PATH = `${bin}:${previous.path}`;
  process.env.BB_SHARE_TEST_PORT = "38124";
  process.env.BB_SHARE_TEST_SERVER = join(process.cwd(), "tests", "host-server.mjs");
  process.env.BB_BOAT_SHARE_HOST_BINARY = join(bin, "host");
  t.after(() => {
    process.env.PATH = previous.path;
    for (const [name, value] of [["BB_SHARE_TEST_PORT", previous.port], ["BB_SHARE_TEST_SERVER", previous.server], ["BB_BOAT_SHARE_HOST_BINARY", previous.host]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  const harness = experimental_createHostEntryHarness(hostEntry);
  t.after(() => harness.experimental_dispose());
  await assert.rejects(harness.experimental_call("share", { workspacePath: root, port: 38124 }), (error: Error) => {
    assert.match(error.message, /Hint: exited 3: Error: ASCII_TOKEN=\[redacted\]/);
    assert.doesNotMatch(error.message, /sk-live-secret/);
    return true;
  });
});

test("host share refuses unsupported workspaces before invoking a host command", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bb-boat-share-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const harness = experimental_createHostEntryHarness(hostEntry);
  t.after(() => harness.experimental_dispose());
  await assert.rejects(harness.experimental_call("share", { workspacePath: root, port: 3000 }), /not the supported Sofia layout/);
});
