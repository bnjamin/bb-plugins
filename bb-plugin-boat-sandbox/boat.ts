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
import { BoatCommandError } from "./errors.js";
import type { BoatRest } from "./rest.js";

export const sandboxSchema = z.object({
  id: z.string(), state: z.string(),
  archiveAfter: z.string().nullable().optional(),
  snapshotAvailable: z.boolean().optional(),
  lastSnapshotStatus: z.string().nullable().optional(),
  // False when the sandbox was created with snapshots off: a stop erases it.
  snapshots: z.boolean().optional(),
  snapshotCompletedAt: z.string().nullable().optional(),
  // The last stop requested; "failing" means Boat refused it and is retrying.
  stop: z.object({ id: z.string().optional(), status: z.string(), error: z.string().nullable().optional() }).nullable().optional(),
});
export type Sandbox = z.infer<typeof sandboxSchema>;
const retentionSchema = z.object({ enabled: z.boolean(), snapshotsOff: z.boolean().optional() });
// Lifecycle calls that can take a while to be accepted.
const SLOW_REQUEST_MS = 300_000;
const sandboxIdSchema = z.string().regex(/^bx_[A-Za-z0-9]+$/);
const sandboxPath = (id: string) => encodeURIComponent(sandboxIdSchema.parse(id));
// Deterministic: an idempotent retry must send exactly the same body.
export type CreateRequest = Pick<Config, "environment" | "machineType" | "ttlSeconds" | "snapshot"> & { monitoring?: boolean };
export function createBody(config: CreateRequest, key: string) {
  return {
    type: config.machineType,
    ttlSeconds: config.ttlSeconds,
    environment: config.environment,
    env: { BB_BOAT_ALLOCATION_KEY: key },
    ...(config.snapshot ? { from: config.snapshot } : {}),
    // Omitted when on, so requests stored before this option stay identical.
    ...(config.monitoring === false ? { monitoring: false } : {}),
  };
}
function errorStateMessage(id: string, api: boolean) {
  return `Boat ${id} is in error and did not recover${api ? " after a power-cycle" : ""}. Its disk is kept for 3 days. ${api ? "" : `Try boat recover ${id} with a current Boat CLI. `}Resuming it with boat resume ${id} loses work written after its last snapshot; contact Boat support first if that work matters.`;
}
// Boat refuses a stop it cannot save, keeps the sandbox running and retries.
// Report that instead of waiting out the timeout. The reason is Boat's own
// text; drop anything that looks like a URL before showing it.
function refusedStop(sandbox: Sandbox) {
  if (sandbox.stop?.status !== "failing") return;
  const reason = (sandbox.stop.error ?? "").replace(/\S*:\/\/\S*/g, "[link]").slice(0, 200).trim();
  throw new Error(`Boat could not save ${sandbox.id}${reason ? ` (${reason})` : ""}. Boat keeps it running and retries the stop for up to 3 days; BB marks the machine asleep once it finishes. Run bb boat inspect for details.`);
}
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

export { BoatCommandError };

// Boat deletes a stopped sandbox's disk this long after the stop.
export const STOPPED_DISK_RETENTION_MS = 14 * 24 * 60 * 60_000;
export function snapshotsOffMessage(scope: string) {
  return `Boat scope ${scope} has Snapshots off, so stopping a sandbox would erase it. Turn off Snapshots off in Boat (Account → Data & privacy) to use BB machines.`;
}

// Boat runs ~/.boat/pre-stop before the final snapshot of every stop,
// including its own auto-stop when BB is offline and the lease runs out.
// BB-initiated suspends already ran the hook, and leave a fresh marker.
const SUSPEND_MARKER = "$HOME/.cache/bb-boat/before-suspend.ran";
export const PRE_STOP_SCRIPT = `#!/bin/bash
# bb-boat-managed: installed by BB's Boat Sandboxes plugin and refreshed on every wake.
marker="${SUSPEND_MARKER}"
if [ -n "$(find "$marker" -mmin -20 2>/dev/null)" ]; then rm -f "$marker"; exit 0; fi
rm -f "$marker"
hook="$HOME/.config/bb-boat/before-suspend"
[ -f "$hook" ] || exit 0
exec bash "$hook"
`;
const PRE_STOP_MARKER = "BB_BOAT_PRESTOP";

export class Boat {
  // With an API key, account, lifecycle and listing calls use Boat's REST API;
  // SSH, exec and hosting still use the CLI.
  constructor(readonly cli: string, readonly scope: string, private readonly runner: Runner = run, readonly rest?: BoatRest) {}
  get transport(): "api" | "cli" { return this.rest ? "api" : "cli"; }
  async command(args: string[], options: RunOptions) {
    return this.runner(this.cli, ["--no-update", "--org", this.scope, "--json", ...args], options);
  }
  async checked(args: string[], options: RunOptions): Promise<string> {
    const result = await this.command(args, options);
    if (result.exitCode !== 0) {
      const output = result.stdout + result.stderr;
      // Only exact structured codes prove absence; auth/network errors must retry.
      let notFound = false;
      let code: string | undefined;
      for (const line of result.stdout.split("\n")) {
        try {
          const data = JSON.parse(line);
          notFound ||= ["sandbox_not_found", "not_found"].includes(data.code) || data.status === 404;
          // Keep only the structured code; messages may carry secrets.
          const candidate = data.code ?? data.error?.code;
          if (typeof candidate === "string" && /^[a-z_]+$/.test(candidate)) code ??= candidate;
        } catch { /* Not JSON. */ }
      }
      throw new BoatCommandError(args[0]!, notFound, output.includes("readiness command did not succeed"), code);
    }
    return result.stdout;
  }
  async json(args: string[], signal: AbortSignal): Promise<unknown> {
    return JSON.parse(await this.checked(args, { signal }));
  }
  async info(id: string, signal: AbortSignal): Promise<Sandbox> {
    const raw = this.rest ? await this.rest.get("info", `/sandboxes/${sandboxPath(id)}`, signal) : await this.json(["info", id], signal);
    return z.object({ sandbox: sandboxSchema }).parse(raw).sandbox;
  }
  async previewExec(id: string, command: string, signal: AbortSignal): Promise<{ exitCode: number; stdout: string }> {
    let raw: unknown;
    try {
      if (this.rest) raw = await this.rest.request("exec", "POST", `/sandboxes/${sandboxPath(id)}/commands`, { signal, body: { command } });
      else {
        // `boat exec` exits with the command's own exit code; the JSON result
        // is still printed, so read it rather than treating that as a failure.
        const result = await this.command(["exec", id, command], { signal });
        raw = JSON.parse(result.stdout);
      }
    } catch { throw new Error("Boat preview command failed. Check Boat login and sandbox state."); }
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
  // `(localhost)` marks a port Boat relays to 127.0.0.1 or ::1.
  async route(id: string, port: number, signal: AbortSignal): Promise<{ hosted: boolean; localhost: boolean }> {
    const result = await this.previewExec(id, "host list", signal);
    if (result.exitCode !== 0) throw new Error("Could not inspect existing Boat hosted routes.");
    const line = result.stdout.split("\n").find((candidate) => new RegExp(`^${port}\\s`).test(candidate));
    return { hosted: line !== undefined && !line.includes("(down)"), localhost: line?.includes("(localhost)") ?? false };
  }
  // Whether the app answers on the sandbox's own address, or only on loopback.
  // A loopback-only app needs Boat's localhost relay; an app on 0.0.0.0 must
  // not get one, because the relay would then hold its port.
  async portBinding(id: string, port: number, signal: AbortSignal): Promise<"address" | "loopback" | "none"> {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid preview port.");
    const probe = `const net=require('node:net'),os=require('node:os');const ok=(host)=>new Promise((r)=>{const s=net.connect({host,port:${port}},()=>{s.destroy();r(true)});s.setTimeout(2000,()=>{s.destroy();r(false)});s.on('error',()=>r(false))});const address=Object.values(os.networkInterfaces()).flat().find((i)=>i&&i.family==='IPv4'&&!i.internal);(async()=>{if(address&&await ok(address.address))process.exit(0);process.exit(await ok('127.0.0.1')||await ok('::1')?3:1)})();`;
    const { exitCode } = await this.previewExec(id, `node -e ${shellQuote(probe)}`, signal);
    return exitCode === 0 ? "address" : exitCode === 3 ? "loopback" : "none";
  }
  async hostPreview(id: string, port: number, signal: AbortSignal, localhost = false): Promise<string> {
    let raw: string;
    if (this.rest) {
      try { raw = JSON.stringify(await this.rest.request("host", "POST", `/sandboxes/${sandboxPath(id)}/host`, { signal, body: { port, title: "BB app preview", public: false, localhost } })); }
      catch (error) {
        signal.throwIfAborted();
        const code = error instanceof BoatCommandError ? ` (${error.code})` : "";
        throw new Error(`Boat could not host port ${port}${code}. Check that the sandbox is running and the API key may host ports.`, { cause: error });
      }
    } else {
      try { raw = await this.checked(["host", id, String(port), "--private", "--title", "BB app preview", ...(localhost ? ["--localhost"] : [])], { signal }); }
      catch (error) {
        if (localhost) throw new Error("This app listens only on localhost. Hosting it needs a Boat CLI with --localhost (run boat self-update on the BB server) or a Boat API key in settings; or start the app on 0.0.0.0.", { cause: error });
        throw error;
      }
    }
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
    if (!this.rest) return this.cliAccountIdentity(signal);
    // The CLI's account identifier is the account email; hashing the same value
    // keeps machines created through either transport manageable by both.
    const { user } = z.object({ user: z.object({ id: z.string().min(1), email: z.string().min(1).nullable().optional(), accountStatus: z.string().optional() }) }).parse(await this.rest.get("status", "/me", signal));
    if (user.accountStatus !== undefined && user.accountStatus !== "active") throw new Error("The Boat account for the configured API key is not active.");
    return createHash("sha256").update(user.email ?? `id:${user.id}`).digest("hex");
  }
  async cliAccountIdentity(signal: AbortSignal): Promise<string> {
    const { account } = z.object({ account: z.object({ identifier: z.string().min(1), loginState: z.string() }) }).parse(await this.json(["status"], signal));
    if (account.loginState !== "active") throw new Error("Sign in to Boat on the BB server before managing machines.");
    return createHash("sha256").update(account.identifier).digest("hex");
  }
  // SSH uses the CLI login while the API key manages lifecycle; both must be
  // the same account, or machines would be created that BB cannot reach.
  // Returns the account identity to pin on a new machine.
  async verifiedAccountIdentity(signal: AbortSignal): Promise<string> {
    if (!this.rest) return this.cliAccountIdentity(signal);
    const [api, cli] = await Promise.all([this.accountIdentity(signal), this.cliAccountIdentity(signal)]);
    if (api !== cli) throw new Error("The Boat API key and the Boat CLI login on the BB server belong to different accounts. Use a key for the signed-in account.");
    return api;
  }
  // The same account through the CLI only, for machines whose pinned identity
  // the API cannot reproduce.
  withoutApi(): Boat { return new Boat(this.cli, this.scope, this.runner); }
  // Whether the environment gives sandboxes a Boat API key, which lets agents
  // in them stop, snapshot or resume their own machine. Needs the API.
  async passesBoatCredentials(environment: string, signal: AbortSignal): Promise<boolean | null> {
    if (!this.rest) return null;
    const raw = await this.rest.get("environments", `/environments?org=${encodeURIComponent(this.scope)}`, signal);
    const { environments } = z.object({ environments: z.array(z.object({ name: z.string(), passSandboxCredentials: z.boolean().optional() }).passthrough()) }).parse(raw);
    return environments.find((candidate) => candidate.name === environment)?.passSandboxCredentials ?? null;
  }
  private async retention(signal: AbortSignal) {
    return retentionSchema.parse(this.rest ? await this.rest.get("data-retention", "/account/data-retention", signal, true) : await this.json(["data-retention", "status"], signal));
  }
  async preflight(signal: AbortSignal): Promise<void> {
    // Both checks are independent read-only API calls; each costs a CLI start
    // plus a round trip, so run them concurrently.
    const [retention, limitsRaw] = await Promise.all([this.retention(signal), this.rest ? this.rest.get("limits", "/limits", signal, true) : this.json(["limits"], signal)]);
    if (retention.enabled) throw new Error("Boat delete-on-stop is enabled. Snapshot-backed BB machines require retention to be enabled in Boat.");
    if (retention.snapshotsOff) throw new Error(snapshotsOffMessage(this.scope));
    const limits = z.object({ canStart: z.boolean(), starts: z.object({
      minute: z.object({ remaining: z.number() }).optional(), hour: z.object({ remaining: z.number() }).optional(), day: z.object({ remaining: z.number() }).optional(),
    }).passthrough().optional() }).parse(limitsRaw);
    if (!limits.canStart || [limits.starts?.minute, limits.starts?.hour, limits.starts?.day].some((window) => window?.remaining === 0)) {
      throw new Error(`Boat scope ${this.scope} cannot start a sandbox now. Run boat --org ${this.scope} limits.`);
    }
  }
  async create(config: CreateRequest, key: string, signal: AbortSignal, onAllocated: (id: string) => Promise<void>): Promise<string> {
    const id = this.rest ? await this.createWithApi(config, key, signal, onAllocated) : await this.createWithCli(config, key, signal, onAllocated);
    const sandbox = await this.waitFor(id, runningStates, signal);
    // An environment or account setting can create the sandbox with snapshots
    // off. Fail now; the allocation is checkpointed, so cleanup removes it.
    if (sandbox.snapshots === false) throw new Error(`Boat created ${id} with snapshots off, so sleep would erase it. ${snapshotsOffMessage(this.scope)}`);
    return id;
  }
  // The allocation key is the idempotency key: a retry with the same body,
  // within Boat's 24 hours, returns the same sandbox instead of a second one.
  private async createWithApi(config: CreateRequest, key: string, signal: AbortSignal, onAllocated: (id: string) => Promise<void>): Promise<string> {
    const body = createBody(config, key);
    const deadline = Date.now() + 180_000;
    for (;;) {
      try {
        const raw = await this.rest!.request("new", "POST", "/sandboxes", { signal, body, scoped: true, idempotent: true, timeoutMs: SLOW_REQUEST_MS, headers: { "idempotency-key": key } });
        const { sandbox } = z.object({ sandbox: z.object({ id: sandboxIdSchema }) }).parse(raw);
        await onAllocated(sandbox.id);
        return sandbox.id;
      } catch (error) {
        // The first request is still creating it; the same key will return it.
        if (error instanceof BoatCommandError && error.code === "idempotency_in_progress" && Date.now() < deadline) { await delay(this.rest!.retryDelayMs * 5, undefined, { signal }); continue; }
        if (error instanceof BoatCommandError && error.code === "idempotency_key_reused") throw new Error("Boat already used this allocation key for a different request. Use bb boat allocations to inspect it.");
        throw error;
      }
    }
  }
  private async createWithCli(config: CreateRequest, key: string, signal: AbortSignal, onAllocated: (id: string) => Promise<void>): Promise<string> {
    let id: string | undefined;
    // Clock skew margin for matching createdAt against the local start time.
    const since = new Date(Date.now() - 60_000).toISOString();
    const args = ["new", "--environment", config.environment, "--type", config.machineType, "--ttl", String(config.ttlSeconds), "--env", `BB_BOAT_ALLOCATION_KEY=${key}`];
    if (config.snapshot) args.push(`--from`, config.snapshot);
    if (config.monitoring === false) args.push("--no-monitoring");
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
  async waitFor(id: string, states: Set<string>, signal: AbortSignal, check?: (sandbox: Sandbox) => void): Promise<Sandbox> {
    const deadline = Date.now() + 900_000;
    let recoveredAt: number | undefined;
    // Power-cycling brings a sandbox back running, which only helps a caller
    // waiting for it to run; a stop would otherwise never be sent again.
    const recoverable = [...states].some((state) => runningStates.has(state));
    while (Date.now() < deadline) {
      const sandbox = await this.info(id, signal);
      if (states.has(sandbox.state)) return sandbox;
      check?.(sandbox);
      if (sandbox.state === "deleted") throw new Error(`Boat ${id} is deleted.`);
      if (sandbox.state === "error") {
        // Boat lost the machine or a start failed. A recover power-cycles it
        // without touching the disk; a resume would lose unsnapshotted work,
        // so it is never done automatically.
        if (recoverable && recoveredAt === undefined && await this.recover(id, signal)) recoveredAt = Date.now();
        else if (recoveredAt === undefined || Date.now() > recoveredAt + 180_000) throw new Error(errorStateMessage(id, this.rest !== undefined));
      }
      await delay(3000, undefined, { signal });
    }
    throw new Error(`Timed out waiting for Boat ${id}.`);
  }
  // Returns whether a power-cycle started. Needs the API; CLI 1.0.9 has no recover.
  async recover(id: string, signal: AbortSignal): Promise<boolean> {
    if (!this.rest) return false;
    try {
      await this.rest.request("recover", "POST", `/sandboxes/${sandboxPath(id)}/recover`, { signal, body: {} });
      return true;
    } catch (error) {
      // A recent recover is still in progress, or the sandbox answers again.
      if (error instanceof BoatCommandError && ["too_soon", "sandbox_is_reachable"].includes(error.code ?? "")) return true;
      if (error instanceof BoatCommandError && error.code !== undefined) return false;
      throw error;
    }
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
      try {
        if (this.rest) await this.rest.request("resume", "POST", `/sandboxes/${sandboxPath(id)}/resume`, { signal, body: { ttlSeconds: ttl }, timeoutMs: SLOW_REQUEST_MS });
        else await this.checked(["resume", id, "--ttl", String(ttl)], { signal, timeoutMs: 900_000 });
      } catch (error) {
        if (error instanceof BoatCommandError && error.code === "snapshot_data_expired") {
          throw new Error(`Boat deleted the saved disk of ${id} because it stayed asleep for more than 14 days. This machine cannot be woken; remove it with bb machine remove.`);
        }
        // A concurrent resume already started it; wait for that one. A lost
        // response may also hide a resume Boat accepted: wait if it left `stopped`.
        const lost = error instanceof BoatCommandError && error.code === "network_error" && !stoppedStates.has((await this.info(id, signal)).state);
        if (!lost && !(error instanceof BoatCommandError && (error.readinessFailed || error.code === "sandbox_resuming"))) throw error;
      }
      await this.waitFor(id, runningStates, signal);
    }
    await this.extend(id, ttl, signal);
  }
  async extend(id: string, ttl: number, signal: AbortSignal): Promise<void> {
    if (this.rest) await this.rest.request("extend", "PATCH", `/sandboxes/${sandboxPath(id)}`, { signal, body: { ttlSeconds: ttl }, idempotent: true });
    else await this.checked(["extend", id, "--ttl", String(ttl)], { signal });
  }
  async stop(id: string, signal: AbortSignal): Promise<void> {
    const retention = await this.retention(signal);
    if (retention.enabled) throw new Error("Boat delete-on-stop is enabled; refusing to stop and destroy this machine's data.");
    let sandbox = await this.info(id, signal);
    if (!stoppedStates.has(sandbox.state)) {
      if (sandbox.snapshots === false) throw new Error(`Boat ${id} was created with snapshots off; stopping it would erase its data. It is left running. Remove the machine when it is no longer needed.`);
      const hooked = runningStates.has(sandbox.state);
      if (hooked) await this.hook(id, "before-suspend", signal);
      try {
        if (this.rest) await this.rest.request("stop", "POST", `/sandboxes/${sandboxPath(id)}/stop`, { signal, body: {}, idempotent: true, timeoutMs: SLOW_REQUEST_MS });
        else await this.checked(["stop", id], { signal, timeoutMs: 900_000 });
      } catch (error) {
        if (!(error instanceof BoatCommandError && error.code === "sandbox_stopping")) {
          // The machine keeps running; a later auto-stop must run the hook again.
          if (hooked) await this.previewExec(id, `rm -f ${SUSPEND_MARKER}`, AbortSignal.timeout(30_000)).catch(() => {});
          throw error;
        }
      }
      sandbox = await this.waitFor(id, stoppedStates, signal, refusedStop);
    }
    if (!sandbox.snapshotAvailable || sandbox.lastSnapshotStatus === "failed") throw new Error(`Boat ${id} stopped without a confirmed snapshot. Inspect it before attempting recovery.`);
  }
  async remove(id: string, signal: AbortSignal): Promise<void> {
    try {
      if (this.rest) await this.rest.request("delete", "DELETE", `/sandboxes/${sandboxPath(id)}`, { signal, idempotent: true, headers: { "x-ascii-confirm-delete": id } });
      else await this.checked(["delete", id, "--yes"], { signal, timeoutMs: 120_000 });
    }
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
      stdin: `set -euo pipefail\nhook="$HOME/.config/bb-boat/${name}"\nif [ -f "$hook" ]; then bash "$hook"; fi\n${name === "before-suspend" ? 'mkdir -p "$HOME/.cache/bb-boat"\ntouch "$HOME/.cache/bb-boat/before-suspend.ran"\n' : ""}`,
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
bb_boat_install_pre_stop() {
  target="$HOME/.boat/pre-stop"
  if [ -e "$target" ] && ! grep -q '^# bb-boat-managed' "$target"; then echo ${PRE_STOP_MARKER}=foreign; return 0; fi
  mkdir -p "$HOME/.boat" &&
  cat > "$target.bb-tmp" <<'BB_BOAT_PRE_STOP_EOF' &&
${PRE_STOP_SCRIPT}BB_BOAT_PRE_STOP_EOF
  chmod 755 "$target.bb-tmp" &&
  mv -f "$target.bb-tmp" "$target"
}
bb_boat_install_pre_stop || echo ${PRE_STOP_MARKER}=failed
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
    if (result.stdout.includes(`${PRE_STOP_MARKER}=foreign`)) report?.log("The template's own ~/.boat/pre-stop was left unchanged; Boat auto-stops run ~/.config/bb-boat/before-suspend only if it calls that hook.\n");
    if (result.stdout.includes(`${PRE_STOP_MARKER}=failed`)) report?.log("Could not install ~/.boat/pre-stop; Boat auto-stops will not run ~/.config/bb-boat/before-suspend.\n");
    const timing = new RegExp(`^${PREPARE_TIMING_MARKER} filesystem=(\\d+) hook=(\\d+)$`, "m").exec(result.stdout);
    if (timing) report?.log(`Boat filesystem ready after ${timing[1]}s; template prepare hook took ${timing[2]}s.\n`);
  }
  async allocationKey(id: string, signal: AbortSignal): Promise<string> {
    const result = z.object({ exitCode: z.number(), stdout: z.string(), timedOut: z.boolean().optional() }).parse(await this.json(["exec", id, "printenv BB_BOAT_ALLOCATION_KEY"], signal));
    if (result.exitCode || result.timedOut) throw new Error("Cannot verify the sandbox allocation key; ensure the sandbox is running.");
    return result.stdout.trim();
  }
}
