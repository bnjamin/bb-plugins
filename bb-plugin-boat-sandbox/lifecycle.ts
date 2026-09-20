import { createHash } from "node:crypto";
import type { BbPluginApi, PluginMachineProviderDeclaration, MachineBootstrapRequest } from "@get-bb/plugin-sdk";
import { Boat } from "./boat.js";
import { allocationSchema, inputsSchema, resourceSchema, providerId, type Allocation, type Config, type Resource } from "./config.js";

export type BoatFactory = (scope: string) => Promise<Boat>;
export const allocationStorageKey = (key: string) => `allocation/${createHash("sha256").update(key).digest("hex")}`;
export const idleKey = (hostId: string) => `idle/${hostId}`;
export async function ownedClient(client: BoatFactory, resource: Pick<Resource, "scope" | "accountIdentity">, signal: AbortSignal): Promise<Boat> {
  const boat = await client(resource.scope);
  if (await boat.accountIdentity(signal) !== resource.accountIdentity) throw new Error("Boat login changed. Restore the account that created this machine before managing it.");
  return boat;
}

export function lifecycle(bb: BbPluginApi, config: () => Promise<Config>, client: BoatFactory, lifetime: AbortSignal) {
  const kv = bb.storage.kv;
  const busy = new Set<string>();
  const signalFor = (signal: AbortSignal) => AbortSignal.any([signal, lifetime]);
  const read = async (key: string): Promise<Allocation | undefined> => {
    const value = await kv.get(allocationStorageKey(key));
    return value === undefined ? undefined : allocationSchema.parse(value);
  };
  async function exclusive<T>(key: string, action: () => Promise<T>): Promise<T> {
    if (busy.has(key)) throw new Error("This Boat allocation is already being changed. Retry when it completes.");
    busy.add(key);
    try { return await action(); } finally { busy.delete(key); }
  }
  const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  // `verified` skips a redundant account lookup when the caller just proved
  // the login while allocating; every Boat CLI call is a process start plus
  // an API round trip on the launch critical path.
  async function connect(resource: Resource, report: MachineBootstrapRequest["report"], signal: AbortSignal, verified?: Boat) {
    const boat = verified ?? await ownedClient(client, resource, signal);
    const prepareStartedAt = Date.now();
    // Mirror the guard/hook split into the plugin log so launches can be
    // compared from `bb plugin logs` without opening each transcript.
    await boat.prepare(resource.sandboxId, signal, { step: (text) => report.step(text), log: (text) => { report.log(text); bb.log.info(`${text.trim()} Sandbox ${resource.sandboxId}.`); } });
    const prepareMs = Date.now() - prepareStartedAt;
    report.step("Connecting the BB daemon");
    const bootstrapStartedAt = Date.now();
    // BB's installer prints one marked line per step (○ active, ✓ done, ! warning,
    // ✗ failed). Mirror those with elapsed seconds into the plugin log so a slow
    // enrollment can be attributed to download, install or join afterwards.
    const installerLine = /^\s*[○✓!✗]\s+(.+)$/u;
    let pending = "";
    const bootstrapReport: MachineBootstrapRequest["report"] = {
      step: (text) => report.step(text),
      log: (text) => {
        report.log(text);
        pending += text;
        let index: number;
        while ((index = pending.indexOf("\n")) !== -1) {
          const match = installerLine.exec(pending.slice(0, index));
          pending = pending.slice(index + 1);
          if (match) bb.log.info(`Daemon bootstrap +${seconds(Date.now() - bootstrapStartedAt)}: ${match[1]}. Sandbox ${resource.sandboxId}.`);
        }
      },
    };
    const { hostId } = await bb.experimental_machines.bootstrap({ key: resource.key, executor: boat.executor(resource.sandboxId), report: bootstrapReport, signal });
    await kv.set(idleKey(hostId), Date.now());
    return { hostId, prepareMs, bootstrapMs: Date.now() - bootstrapStartedAt };
  }
  function logTimings(operation: string, resource: Resource, report: MachineBootstrapRequest["report"], startedAt: number, stages: Record<string, number>) {
    const detail = Object.entries(stages).map(([stage, ms]) => `${stage} ${seconds(ms)}`).join(", ");
    const summary = `Boat ${operation} of ${resource.sandboxId} took ${seconds(Date.now() - startedAt)} (${detail}).`;
    report.log(`${summary}\n`);
    bb.log.info(`${summary} Allocation ${resource.key}.`);
  }
  async function remove(resource: Resource, signal: AbortSignal) {
    await (await ownedClient(client, resource, signal)).remove(resource.sandboxId, signal);
    // A tombstone prevents a stale create callback from allocating again.
    await kv.set(`removed/${allocationStorageKey(resource.key)}`, true);
    await kv.delete(allocationStorageKey(resource.key));
  }
  const definition: PluginMachineProviderDeclaration<typeof inputsSchema> = {
    id: providerId, displayName: "Boat", icon: "Ship",
    description: "A Boat.dev sandbox with saved state across sleep and wake.",
    ephemeral: true, inputs: inputsSchema,
    async availability() {
      try { await client((await config()).scope); return { status: "available" }; }
      catch { return { status: "setup-required", message: "Install and sign in to the Boat CLI on the BB server; configure Boat Sandboxes in Settings." }; }
    },
    async validate() {
      try { const current = await config(); await (await client(current.scope)).preflight(AbortSignal.any([lifetime, AbortSignal.timeout(15_000)])); return { action: "accept" }; }
      catch (error) { return { action: "refuse", message: error instanceof Error ? error.message : "Boat preflight failed." }; }
    },
    async create(context) {
      return exclusive(context.key, async () => {
        const signal = signalFor(context.signal);
        if (await kv.get(`removed/${allocationStorageKey(context.key)}`)) throw new Error("This Boat allocation was removed; create a new machine.");
        const startedAt = Date.now();
        const stages: Record<string, number> = {};
        let allocation = await read(context.key);
        let resource: Resource;
        let verified: Boat | undefined;
        if (allocation) {
          if (!allocation.sandboxId) throw new Error(`Uncertain Boat allocation ${context.key}. Use bb boat allocations, then recover or clear it after checking Boat. No second sandbox was created.`);
          resource = resourceSchema.parse({ ...allocation, version: 1 });
          await context.checkpoint(resource);
          verified = await ownedClient(client, resource, signal);
          await verified.resume(resource.sandboxId, resource.ttlSeconds, signal);
          stages.resume = Date.now() - startedAt;
        } else {
          const current = { ...await config(), ...inputsSchema.parse(context.inputs) };
          const boat = await client(current.scope);
          const [, accountIdentity] = await Promise.all([boat.preflight(signal), boat.accountIdentity(signal)]);
          stages.preflight = Date.now() - startedAt;
          allocation = { key: context.key, scope: current.scope, accountIdentity, sandboxId: null, ttlSeconds: current.ttlSeconds };
          // Boat has no create idempotency key. Persist intent before new; a lost
          // response must never cause a second sandbox on retry.
          await kv.set(allocationStorageKey(context.key), allocation);
          context.report.step("Creating the Boat sandbox");
          const createStartedAt = Date.now();
          let saved: Resource | undefined;
          await boat.create(current, context.key, signal, async (sandboxId) => {
            saved = { ...allocation!, sandboxId, version: 1 };
            await kv.set(allocationStorageKey(context.key), { ...allocation, sandboxId });
            await context.checkpoint(saved);
          });
          if (!saved) throw new Error("Boat allocation was not checkpointed.");
          resource = saved;
          stages.sandbox = Date.now() - createStartedAt;
          verified = boat;
        }
        const connected = await connect(resource, context.report, signal, verified);
        logTimings("create", resource, context.report, startedAt, { ...stages, prepare: connected.prepareMs, daemon: connected.bootstrapMs });
        return { status: "created", name: `Boat ${resource.sandboxId}`, resource };
      });
    },
    async reconcileCleanup(context) {
      return exclusive(context.key, async () => {
        const allocation = await read(context.key);
        if (!allocation) return { status: "removed" };
        if (!allocation.sandboxId) return { status: "failed", message: `Boat allocation ${context.key} is uncertain. Run bb boat allocations and reconcile before cleanup.` };
        await remove(resourceSchema.parse({ ...allocation, version: 1 }), signalFor(context.signal));
        return { status: "removed" };
      });
    },
    async suspend(context) {
      const resource = resourceSchema.parse(context.resource);
      const signal = signalFor(context.signal);
      await (await ownedClient(client, resource, signal)).stop(resource.sandboxId, signal);
      // Boat stop saves the snapshot on the same ID. Never delete it on sleep.
      await context.checkpoint(resource);
      return { resource };
    },
    async resume(context) {
      const resource = resourceSchema.parse(context.resource);
      const signal = signalFor(context.signal);
      const startedAt = Date.now();
      const boat = await ownedClient(client, resource, signal);
      await boat.resume(resource.sandboxId, resource.ttlSeconds, signal);
      const resumeMs = Date.now() - startedAt;
      await context.checkpoint(resource);
      const connected = await connect(resource, context.report, signal, boat);
      logTimings("resume", resource, context.report, startedAt, { resume: resumeMs, prepare: connected.prepareMs, daemon: connected.bootstrapMs });
      return { resource };
    },
    async remove(context) {
      const resource = resourceSchema.parse(context.resource);
      return exclusive(resource.key, async () => {
        await remove(resource, signalFor(context.signal));
        await kv.delete(idleKey(context.hostId));
        return { status: "removed" };
      });
    },
  };
  return {
    definition,
    async allocations() {
      const keys = await kv.list("allocation/");
      return Promise.all(keys.map(async (key) => allocationSchema.parse(await kv.get(key))));
    },
    async recover(key: string, sandboxId: string, signal: AbortSignal) {
      return exclusive(key, async () => {
        const allocation = await read(key);
        if (!allocation || allocation.sandboxId) throw new Error("Only an uncertain allocation can be recovered.");
        resourceSchema.shape.sandboxId.parse(sandboxId);
        if (await (await ownedClient(client, allocation, signalFor(signal))).allocationKey(sandboxId, signalFor(signal)) !== key) throw new Error("Sandbox allocation key does not match. Refusing to adopt it.");
        await kv.set(allocationStorageKey(key), { ...allocation, sandboxId });
      });
    },
    async clearPending(key: string) {
      return exclusive(key, async () => {
        const allocation = await read(key);
        if (!allocation || allocation.sandboxId) throw new Error("Only an uncertain allocation can be cleared.");
        await kv.set(`removed/${allocationStorageKey(key)}`, true);
        await kv.delete(allocationStorageKey(key));
      });
    },
  };
}
