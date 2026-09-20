import { access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { MachineExecutor } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { run, shellQuote, type Runner, type RunOptions } from "./process.js";
import type { Config } from "./config.js";

export const sandboxSchema = z.object({
  id: z.string(), state: z.string(),
  archiveAfter: z.string().nullable().optional(),
  snapshotAvailable: z.boolean().optional(),
  lastSnapshotStatus: z.string().nullable().optional(),
});
export type Sandbox = z.infer<typeof sandboxSchema>;
export const runningStates = new Set(["ready", "idle", "running"]);
export const stoppedStates = new Set(["stopped", "archived"]);
export interface PrepareProgress { step(text: string): void; log(text: string): void }
const PREPARE_STAGE_MARKER = "BB_BOAT_PREPARE_STAGE=hook";
const USERNS_STAGE_MARKER = "BB_BOAT_PREPARE_STAGE=userns";
const PREPARE_TIMING_MARKER = "BB_BOAT_PREPARE_TIMING";

// Boat is the outer isolation boundary. Ubuntu's extra userns restriction
// prevents agent sandboxes from configuring even their private loopback device.
// Reapply after restore: snapshots preserve files, not kernel sysctl state.
export const userNamespacePreparationScript = `
if sysctl -n kernel.apparmor_restrict_unprivileged_userns >/dev/null 2>&1; then
  bb_boat_userns_command='printf "%s\\n" "kernel.apparmor_restrict_unprivileged_userns=0" > /etc/sysctl.d/99-bb-boat-userns.conf
sysctl -q -p /etc/sysctl.d/99-bb-boat-userns.conf'
  if [ "$(id -u)" = 0 ]; then
    sh -ec "$bb_boat_userns_command"
  else
    sudo -n sh -ec "$bb_boat_userns_command"
  fi
fi
`;

export async function resolveCli(configured: string): Promise<string> {
  const candidates = configured
    ? [configured.startsWith("~/") ? join(homedir(), configured.slice(2)) : configured]
    : [...(process.env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, "boat")), join(homedir(), ".ascii/bin/boat")];
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* Try the next location. */ }
  }
  throw new Error("Boat CLI not found. Install Boat on the BB server or set cliPath.");
}

// REST/CLI error bodies may contain credentials or signed desktop URLs.
// Only expose our own diagnostics, never raw Boat output.
export class BoatCommandError extends Error {
  constructor(public readonly operation: string, public readonly notFound: boolean, public readonly readinessFailed: boolean) {
    super(`Boat ${operation} failed. Check Boat login, billing scope, and sandbox state with the Boat CLI.`);
  }
}

export class Boat {
  constructor(readonly cli: string, readonly scope: string, private readonly runner: Runner = run) {}
  async command(args: string[], options: RunOptions) {
    return this.runner(this.cli, ["--no-update", "--org", this.scope, "--json", ...args], options);
  }
  async checked(args: string[], options: RunOptions): Promise<string> {
    const result = await this.command(args, options);
    if (result.exitCode !== 0) {
      const output = result.stdout + result.stderr;
      // Only exact structured codes prove absence; auth/network errors must retry.
      let notFound = false;
      for (const line of result.stdout.split("\n")) {
        try {
          const data = JSON.parse(line);
          notFound ||= ["sandbox_not_found", "not_found"].includes(data.code) || data.status === 404;
        } catch { /* Not JSON. */ }
      }
      throw new BoatCommandError(args[0]!, notFound, output.includes("readiness command did not succeed"));
    }
    return result.stdout;
  }
  async json(args: string[], signal: AbortSignal): Promise<unknown> {
    return JSON.parse(await this.checked(args, { signal }));
  }
  async info(id: string, signal: AbortSignal): Promise<Sandbox> {
    return z.object({ sandbox: sandboxSchema }).parse(await this.json(["info", id], signal)).sandbox;
  }
  async previewExec(id: string, command: string, signal: AbortSignal): Promise<{ exitCode: number; stdout: string }> {
    let raw: unknown;
    try { raw = await this.json(["exec", id, command], signal); }
    catch { throw new Error("Boat preview command failed. Check Boat login and sandbox state."); }
    const data = z.object({ exitCode: z.number(), stdout: z.string(), timedOut: z.boolean().optional() }).safeParse(raw);
    if (!data.success || data.data.timedOut) throw new Error("Boat preview command did not finish. Check the sandbox state.");
    return data.data;
  }
  async previewPort(id: string, cwd: string, daemon: string, signal: AbortSignal): Promise<number | null> {
    const result = await this.previewExec(id, `cd ${shellQuote(cwd)} && mise exec -- pitchfork status ${shellQuote(daemon)} --json`, signal);
    if (result.exitCode !== 0) return null;
    try {
      const data = JSON.parse(result.stdout);
      const port = data.port?.[0];
      return data.status === "running" && Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
    } catch { return null; }
  }
  async portReady(id: string, port: number, signal: AbortSignal): Promise<boolean> {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid preview port.");
    const probe = `const net=require('node:net');const s=net.connect({host:'127.0.0.1',port:${port}},()=>{s.destroy();process.exit(0)});s.setTimeout(2000,()=>process.exit(1));s.on('error',()=>process.exit(1));`;
    return (await this.previewExec(id, `node -e ${shellQuote(probe)}`, signal)).exitCode === 0;
  }
  async hostedPort(id: string, port: number, signal: AbortSignal): Promise<boolean> {
    const result = await this.previewExec(id, "host list", signal);
    if (result.exitCode !== 0) throw new Error("Could not inspect existing Boat hosted routes.");
    return result.stdout.split("\n").some(line => new RegExp(`^${port}\\s`).test(line) && !line.includes("(down)"));
  }
  async hostPreview(id: string, port: number, signal: AbortSignal): Promise<string> {
    const raw = await this.checked(["host", id, String(port), "--private", "--title", "BB app preview"], { signal });
    try {
      const data = JSON.parse(raw);
      const url = new URL(data.url);
      if (url.protocol !== "https:" || !/^[a-z0-9-]+\.on\.(boat|ascii)\.dev$/.test(url.hostname) || url.username || url.password || !url.searchParams.get("_token") || data.isProtected !== true) throw new Error();
      return url.href;
    } catch { throw new Error("Boat did not return a protected HTTPS preview URL. Update Boat and retry."); }
  }
  async hidePreview(id: string, port: number, signal: AbortSignal): Promise<void> {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid preview port.");
    if ((await this.previewExec(id, `host hide ${port}`, signal)).exitCode !== 0) throw new Error("Could not hide the Boat preview route.");
  }
  async accountIdentity(signal: AbortSignal): Promise<string> {
    const { account } = z.object({ account: z.object({ identifier: z.string().min(1), loginState: z.string() }) }).parse(await this.json(["status"], signal));
    if (account.loginState !== "active") throw new Error("Sign in to Boat on the BB server before managing machines.");
    return createHash("sha256").update(account.identifier).digest("hex");
  }
  async preflight(signal: AbortSignal): Promise<void> {
    // Both checks are independent read-only API calls; each costs a CLI start
    // plus a round trip, so run them concurrently.
    const [retentionRaw, limitsRaw] = await Promise.all([this.json(["data-retention", "status"], signal), this.json(["limits"], signal)]);
    const retention = z.object({ enabled: z.boolean() }).parse(retentionRaw);
    if (retention.enabled) throw new Error("Boat delete-on-stop is enabled. Snapshot-backed BB machines require retention to be enabled in Boat.");
    const limits = z.object({ canStart: z.boolean(), starts: z.object({
      minute: z.object({ remaining: z.number() }).optional(), hour: z.object({ remaining: z.number() }).optional(), day: z.object({ remaining: z.number() }).optional(),
    }).passthrough().optional() }).parse(limitsRaw);
    if (!limits.canStart || [limits.starts?.minute, limits.starts?.hour, limits.starts?.day].some((window) => window?.remaining === 0)) {
      throw new Error(`Boat scope ${this.scope} cannot start a sandbox now. Run boat --org ${this.scope} limits.`);
    }
  }
  async create(config: Config, key: string, signal: AbortSignal, onAllocated: (id: string) => Promise<void>): Promise<string> {
    let id: string | undefined;
    // Clock skew margin for matching createdAt against the local start time.
    const since = new Date(Date.now() - 60_000).toISOString();
    const args = ["new", "--environment", config.environment, "--type", config.machineType, "--ttl", String(config.ttlSeconds), "--env", `BB_BOAT_ALLOCATION_KEY=${key}`];
    if (config.snapshot) args.push(`--from`, config.snapshot);
    let failure: unknown;
    try {
      await this.checked(args, { signal, timeoutMs: 900_000, onLine: async (line) => {
        const event = z.object({ event: z.string(), id: z.string().regex(/^bx_[A-Za-z0-9]+$/).optional() }).passthrough().parse(JSON.parse(line));
        if (["created", "ready"].includes(event.event) && event.id && event.id !== id) {
          if (id) throw new Error("Boat returned conflicting sandbox IDs.");
          id = event.id;
          await onAllocated(id);
        }
      } });
    } catch (error) {
      if (id && !(error instanceof BoatCommandError && error.readinessFailed)) throw error;
      failure = error;
    }
    if (!id) {
      // Boat's create call has timed out client-side while the sandbox was
      // still created. The per-sandbox allocation marker identifies it; adopt
      // it rather than leaving an uncertain allocation for manual recovery.
      id = await this.findAllocated(key, since, signal);
      if (!id) throw failure ?? new Error("Boat did not return a sandbox ID. Allocation remains pending for manual reconciliation.");
      await onAllocated(id);
    }
    await this.waitFor(id, runningStates, signal);
    return id;
  }
  private async findAllocated(key: string, since: string, signal: AbortSignal): Promise<string | undefined> {
    const listSchema = z.object({ sandboxes: z.array(z.object({ id: z.string(), state: z.string(), createdAt: z.string().nullable().optional() }).passthrough()) });
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      let candidates: { id: string; state: string }[] = [];
      try {
        candidates = listSchema.parse(await this.json(["list", "--all"], signal)).sandboxes
          .filter((sandbox) => (sandbox.createdAt ?? "") >= since && !stoppedStates.has(sandbox.state) && !["error", "deleted"].includes(sandbox.state));
      } catch { /* Transient listing failure; retry below. */ }
      if (candidates.length === 0) return undefined;
      for (const candidate of candidates) {
        if (!runningStates.has(candidate.state)) continue;
        try { if (await this.allocationKey(candidate.id, signal) === key) return candidate.id; }
        catch { /* Not ours, or not accepting commands yet. */ }
      }
      await delay(5000, undefined, { signal });
    }
    return undefined;
  }
  async waitFor(id: string, states: Set<string>, signal: AbortSignal): Promise<Sandbox> {
    const deadline = Date.now() + 900_000;
    while (Date.now() < deadline) {
      const sandbox = await this.info(id, signal);
      if (states.has(sandbox.state)) return sandbox;
      if (["error", "deleted"].includes(sandbox.state)) throw new Error(`Boat ${id} is ${sandbox.state}.`);
      await delay(3000, undefined, { signal });
    }
    throw new Error(`Timed out waiting for Boat ${id}.`);
  }
  async resume(id: string, ttl: number, signal: AbortSignal): Promise<void> {
    const current = await this.info(id, signal);
    if (!runningStates.has(current.state)) {
      if (!stoppedStates.has(current.state)) {
        await this.waitFor(id, new Set([...runningStates, ...stoppedStates]), signal);
        return this.resume(id, ttl, signal);
      }
      if (!current.snapshotAvailable) throw new Error(`Boat ${id} has no recoverable snapshot. Refusing to replace its data with a fresh machine.`);
      await this.preflight(signal);
      try { await this.checked(["resume", id, "--ttl", String(ttl)], { signal, timeoutMs: 900_000 }); }
      catch (error) { if (!(error instanceof BoatCommandError && error.readinessFailed)) throw error; }
      await this.waitFor(id, runningStates, signal);
    }
    await this.extend(id, ttl, signal);
  }
  async extend(id: string, ttl: number, signal: AbortSignal): Promise<void> {
    await this.checked(["extend", id, "--ttl", String(ttl)], { signal });
  }
  async stop(id: string, signal: AbortSignal): Promise<void> {
    const retention = z.object({ enabled: z.boolean() }).parse(await this.json(["data-retention", "status"], signal));
    if (retention.enabled) throw new Error("Boat delete-on-stop is enabled; refusing to stop and destroy this machine's data.");
    let sandbox = await this.info(id, signal);
    if (!stoppedStates.has(sandbox.state)) {
      if (runningStates.has(sandbox.state)) await this.hook(id, "before-suspend", signal);
      await this.checked(["stop", id], { signal, timeoutMs: 900_000 });
      sandbox = await this.waitFor(id, stoppedStates, signal);
    }
    if (!sandbox.snapshotAvailable || sandbox.lastSnapshotStatus === "failed") throw new Error(`Boat ${id} stopped without a confirmed snapshot. Inspect it before attempting recovery.`);
  }
  async remove(id: string, signal: AbortSignal): Promise<void> {
    try { await this.checked(["delete", id, "--yes"], { signal, timeoutMs: 120_000 }); }
    catch (error) {
      if (!(error instanceof BoatCommandError && error.notFound)) throw error;
    }
  }
  executor(id: string): MachineExecutor {
    return { exec: async ({ command, stdin, timeoutMs, signal, onOutput }) => {
      const result = await this.command(["ssh", id, command.map(shellQuote).join(" ")], { stdin, timeoutMs, signal, onOutput });
      if (result.exitCode !== 0 && /permission denied|operation not permitted|read-only file system/i.test(result.stderr)) {
        throw new Error("Boat SSH was denied access. Verify the BB server can write Boat's CLI state and SSH known_hosts, and can access the sandbox.");
      }
      return { exitCode: result.exitCode };
    } };
  }
  async hook(id: string, name: "prepare" | "before-suspend", signal: AbortSignal): Promise<void> {
    const result = await this.executor(id).exec({
      command: ["bash", "-s"],
      stdin: `set -euo pipefail\nhook="$HOME/.config/bb-boat/${name}"\nif [ -f "$hook" ]; then bash "$hook"; fi\n`,
      timeoutMs: 600_000, signal, onOutput: () => {},
    });
    if (result.exitCode !== 0) throw new Error(`Boat ${name} hook failed. Inspect ~/.config/bb-boat/${name} on the machine; the lifecycle operation was not completed.`);
  }
  async prepare(id: string, signal: AbortSignal, report?: PrepareProgress): Promise<void> {
    // Observed live: populated-directory renames on lazyfs can lose visible
    // children. BB installs and promotes directories during setup.
    // The guard and the optional prepare hook share one SSH session; a second
    // handshake per launch is measurable. The hook stage is marked on stdout so
    // its failure is reported distinctly, and only the timing line is read back.
    report?.step("Waiting for the Boat filesystem and checking tools");
    const script = `set -euo pipefail
bb_boat_started=$(date +%s)
deadline=$(( bb_boat_started + 240 ))
while true; do
  boat_mount_source=$(findmnt -n -o SOURCE -T "$HOME")
  [ "$boat_mount_source" = ascii-lazyfs ] || break
  [ "$(date +%s)" -lt "$deadline" ] || { echo 'Boat home restore timed out' >&2; exit 1; }
  sleep 2
done
probe=$(mktemp -d "$HOME/.bb-boat-restore.XXXXXX")
trap 'rm -rf "$probe"' EXIT
mkdir "$probe/before"
printf ready > "$probe/before/file"
mv "$probe/before" "$probe/after"
test "$(cat "$probe/after/file")" = ready
command -v node >/dev/null
command -v npm >/dev/null
command -v curl >/dev/null
command -v git >/dev/null
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)'
bb_boat_hydrated=$(date +%s)
echo ${USERNS_STAGE_MARKER}
${userNamespacePreparationScript}
echo ${PREPARE_STAGE_MARKER}
hook="$HOME/.config/bb-boat/prepare"
if [ -f "$hook" ]; then bash "$hook"; fi
echo "${PREPARE_TIMING_MARKER} filesystem=$(( bb_boat_hydrated - bb_boat_started )) hook=$(( $(date +%s) - bb_boat_hydrated ))"
`;
    const result = await this.command(["ssh", id, ["bash", "-s"].map(shellQuote).join(" ")], { stdin: script, timeoutMs: 900_000, signal });
    if (result.exitCode !== 0) {
      if (result.stdout.includes(PREPARE_STAGE_MARKER)) throw new Error("Boat prepare hook failed. Inspect ~/.config/bb-boat/prepare on the machine; the lifecycle operation was not completed.");
      if (result.stdout.includes(USERNS_STAGE_MARKER)) throw new Error("Boat user namespace preparation failed. Allow non-interactive sudo to write /etc/sysctl.d/99-bb-boat-userns.conf and apply kernel.apparmor_restrict_unprivileged_userns=0 inside the Boat sandbox.");
      if (/permission denied|operation not permitted|read-only file system/i.test(result.stderr)) {
        throw new Error("Boat SSH was denied access. Verify the BB server can write Boat's CLI state and SSH known_hosts, and can access the sandbox.");
      }
      throw new Error("Boat preparation failed. The home filesystem must finish restoring and Node 22+, npm, curl, and git must be installed.");
    }
    const timing = new RegExp(`^${PREPARE_TIMING_MARKER} filesystem=(\\d+) hook=(\\d+)$`, "m").exec(result.stdout);
    if (timing) report?.log(`Boat filesystem ready after ${timing[1]}s; template prepare hook took ${timing[2]}s.\n`);
  }
  async allocationKey(id: string, signal: AbortSignal): Promise<string> {
    const result = z.object({ exitCode: z.number(), stdout: z.string(), timedOut: z.boolean().optional() }).parse(await this.json(["exec", id, "printenv BB_BOAT_ALLOCATION_KEY"], signal));
    if (result.exitCode || result.timedOut) throw new Error("Cannot verify the sandbox allocation key; ensure the sandbox is running.");
    return result.stdout.trim();
  }
}
