// Explicit live test: creates one sandbox, resumes it once, and deletes it.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Boat, resolveCli } from "../boat.js";
import { run } from "../process.js";
import { configSchema } from "../config.js";

if (!process.argv.includes("--live")) throw new Error("Pass --live to create a disposable Boat sandbox.");
const config = configSchema.parse({ scope: process.env.BB_BOAT_SCOPE ?? "personal", environment: process.env.BB_BOAT_ENVIRONMENT ?? "base", ttlSeconds: 1800 });
const boat = new Boat(await resolveCli(""), config.scope, async (executable, args, options) => {
  const result = await run(executable, args, options);
  if (args[4] === "ssh" && result.exitCode !== 0) {
    // This smoke test sends only fixed non-secret scripts, never enrollment.
    console.error("SSH diagnostic", result.exitCode, result.stderr.replace(/https?:\/\/\S+/g, "[URL]").slice(-2000));
    console.error("SSH stdout", result.stdout.replace(/https?:\/\/\S+/g, "[URL]").slice(-2000));
  }
  return result;
});
const signal = AbortSignal.timeout(25 * 60_000);
const key = `bb-smoke-${randomUUID()}`;
let sandboxId: string | undefined;
const checkpointPath = new URL("../.smoke-resource.json", import.meta.url);
async function execute(script: string) {
  const result = await boat.executor(sandboxId!).exec({ command: ["bash", "-s"], stdin: script, signal, timeoutMs: 120_000, onOutput: () => {} });
  assert.equal(result.exitCode, 0);
}
try {
  await boat.preflight(signal);
  await boat.create(config, key, signal, async (id) => {
    sandboxId = id;
    await writeFile(checkpointPath, JSON.stringify({ scope: config.scope, id, key }), { mode: 0o600 });
    console.log(`Allocated ${id}`);
  });
  await boat.prepare(sandboxId!, signal);
  await execute('set -eu\nprintf "%s" "bb-persistence-check" > "$HOME/.bb-boat-smoke-marker"\n');
  console.log("Prepared sandbox and wrote persistence marker");
  await boat.stop(sandboxId!, signal);
  console.log("Stopped with snapshot");
  await boat.resume(sandboxId!, config.ttlSeconds, signal);
  await boat.prepare(sandboxId!, signal);
  await execute('set -eu\ntest "$(cat "$HOME/.bb-boat-smoke-marker")" = "bb-persistence-check"\n');
  assert.equal(await boat.allocationKey(sandboxId!, signal), key);
  console.log("Resume, filesystem persistence and allocation marker verified");
} finally {
  if (sandboxId) {
    await boat.remove(sandboxId, AbortSignal.timeout(180_000));
    console.log(`Deleted ${sandboxId}`);
    await writeFile(checkpointPath, JSON.stringify({ scope: config.scope, id: sandboxId, deleted: true }), { mode: 0o600 });
  }
}
