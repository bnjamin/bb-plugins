import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { providerId, resourceSchema } from "./config.js";
import { idleKey, ownedClient, type BoatFactory } from "./lifecycle.js";
import { revealUrl } from "./browser.js";

export const previewOptions = z.object({
  threadId: z.string().min(1),
  port: z.number().int().min(1).max(65535).optional(),
  daemon: z.string().regex(/^[A-Za-z0-9_-]+$/).default("rails"),
  command: z.string().min(1).max(10000).default("mise run dev"),
  start: z.boolean().default(false),
  includeUrl: z.boolean().default(false),
  browserHost: z.string().optional(),
  browserInstance: z.string().optional(),
});
export type PreviewOptions = z.input<typeof previewOptions>;
const recordSchema = z.object({
  hostId: z.string(), environmentId: z.string(), threadId: z.string(), port: z.number().int(),
  terminalId: z.string().nullable(), owned: z.boolean(),
});
const previewKey = (hostId: string, port: number) => `preview/${createHash("sha256").update(`${hostId}:${port}`).digest("hex")}`;

export function parsePreviewArgs(args: string[], threadId?: string, start = false): PreviewOptions {
  const values: Record<string, unknown> = { threadId, start };
  const flags: Record<string, string> = { "--thread": "threadId", "--port": "port", "--daemon": "daemon", "--command": "command", "--browser-host": "browserHost", "--browser-instance": "browserInstance" };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--url") { values.includeUrl = true; continue; }
    const key = flags[arg];
    if (!key || !args[i + 1] || args[i + 1]!.startsWith("--")) throw new Error(`Invalid preview option ${arg}. Run bb boat ${start ? "dev" : "preview"} --help.`);
    if (key === "command" && !start) throw new Error("--command requires bb boat dev.");
    values[key] = key === "port" ? Number(args[++i]) : args[++i];
  }
  if (!values.threadId) throw new Error("Run this in a BB thread, or pass --thread <id>.");
  const parsed = previewOptions.safeParse(values);
  if (!parsed.success) throw new Error("Invalid preview options: port must be 1–65535 and daemon must be a simple name.");
  return parsed.data;
}

export function previews(bb: BbPluginApi, client: BoatFactory, lifetime: AbortSignal) {
  const busy = new Set<string>();
  async function target(threadId: string, signal: AbortSignal) {
    const thread = await bb.sdk.threads.get({ threadId });
    if (!thread.environmentId) throw new Error("This thread has no environment. Select a Boat sandbox first.");
    const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
    if (!environment.path) throw new Error("This environment has no working directory yet.");
    const host = await bb.sdk.hosts.get({ hostId: environment.hostId });
    if (host.machineProviderId !== providerId) throw new Error("This thread is not on a Boat machine.");
    if (host.status !== "connected" || host.lifecycle.phase !== "active") throw new Error("Resume the thread's Boat machine before opening its preview.");
    const resource = resourceSchema.parse(await bb.experimental_machines.getResource(host.id));
    return { environment: { ...environment, path: environment.path }, host, resource, boat: await ownedClient(client, resource, signal) };
  }

  async function open(input: PreviewOptions, caller?: AbortSignal) {
    const options = previewOptions.parse(input);
    const signal = AbortSignal.any([lifetime, ...(caller ? [caller] : []), AbortSignal.timeout(120_000)]);
    const { environment, host, resource, boat } = await target(options.threadId, signal);
    if (busy.has(environment.id)) throw new Error("A preview is already starting in this environment. Retry shortly.");
    busy.add(environment.id);
    try {
      const resolvedPort = async () => options.port !== undefined
        ? (await boat.portReady(resource.sandboxId, options.port, signal) ? options.port : null)
        : await boat.previewPort(resource.sandboxId, environment.path, options.daemon, signal);
      let port = await resolvedPort();
      let terminalId: string | null = null;
      if (port === null && options.start) {
        const terminalKey = `preview-terminal/${environment.id}`;
        const previousId = await bb.storage.kv.get<string>(terminalKey);
        const previous = previousId ? await bb.sdk.terminals.get({ terminalId: previousId }).catch(() => null) : null;
        if (previous?.status === "running") terminalId = previous.id;
        else {
          const terminal = await bb.sdk.terminals.create({
            scope: { kind: "thread", threadId: options.threadId }, cols: 100, rows: 30,
            title: "Boat development", start: { mode: "command", command: options.command },
          });
          terminalId = terminal.id;
          await bb.storage.kv.set(terminalKey, terminalId);
        }
        const deadline = Date.now() + 90_000;
        while (port === null && Date.now() < deadline) {
          const terminal = await bb.sdk.terminals.get({ terminalId });
          if (terminal.status !== "running") throw new Error(`Development exited before the app was ready. Inspect terminal ${terminalId}.`);
          await delay(2000, undefined, { signal });
          port = await resolvedPort();
        }
      }
      if (port === null) throw new Error("App is not ready. Start it first or use bb boat dev; pass --port for apps without Pitchfork. Any started terminal remains available for inspection.");
      const key = previewKey(host.id, port);
      const previous = recordSchema.safeParse(await bb.storage.kv.get(key));
      const existing = await boat.hostedPort(resource.sandboxId, port, signal);
      // Before claiming a route, persist ownership so a lost response/reload can clean it up.
      const record = { hostId: host.id, environmentId: environment.id, threadId: options.threadId, port,
        terminalId: terminalId ?? (previous.success ? previous.data.terminalId : null),
        owned: !existing || (previous.success && previous.data.owned) };
      await bb.storage.kv.set(key, record);
      const url = await boat.hostPreview(resource.sandboxId, port, signal);
      await bb.storage.kv.set(idleKey(host.id), Date.now());
      const { browser, matched, browserTarget } = await revealUrl(bb, url, options);
      const message = browser !== "unavailable"
        ? `Preview tab ${browser} on host ${browserTarget!.hostId}, instance ${browserTarget!.instanceId}. Select the thread in that desktop window to see it. Inspect with bb browser instances --host ${browserTarget!.hostId}.`
        : matched === null
          ? "Preview ready, but BB could not open its browser. Use --url to retrieve the private link."
          : `Preview ready; ${matched} desktop windows matched. Select one with --browser-host/--browser-instance or retrieve the private link with --url.`;
      return { hostId: host.id, port, origin: new URL(url).origin, browser, browserTarget, terminalId: record.terminalId, message, ...(options.includeUrl ? { url } : {}) };
    } finally { busy.delete(environment.id); }
  }

  async function stop(threadId: string, caller?: AbortSignal) {
    const signal = AbortSignal.any([lifetime, ...(caller ? [caller] : []), AbortSignal.timeout(60_000)]);
    const { environment, resource, boat } = await target(threadId, signal);
    const hidden: number[] = [];
    for (const key of await bb.storage.kv.list("preview/")) {
      const parsed = recordSchema.safeParse(await bb.storage.kv.get(key));
      if (!parsed.success || parsed.data.environmentId !== environment.id) continue;
      if (parsed.data.owned) { await boat.hidePreview(resource.sandboxId, parsed.data.port, signal); hidden.push(parsed.data.port); }
      await bb.storage.kv.delete(key);
    }
    return { hidden, message: "Plugin-created preview routes removed. Development processes are still running." };
  }

  async function reconcile() {
    for (const key of await bb.storage.kv.list("preview/")) {
      if (lifetime.aborted) return;
      const parsed = recordSchema.safeParse(await bb.storage.kv.get(key));
      if (!parsed.success || !parsed.data.owned || busy.has(parsed.data.environmentId)) continue;
      const record = parsed.data;
      try {
        const host = await bb.sdk.hosts.get({ hostId: record.hostId });
        if (host.machineProviderId !== providerId || host.status !== "connected" || host.lifecycle.phase !== "active") continue;
        const resource = resourceSchema.parse(await bb.experimental_machines.getResource(host.id));
        const signal = AbortSignal.any([lifetime, AbortSignal.timeout(30_000)]);
        const boat = await ownedClient(client, resource, signal);
        if (await boat.portReady(resource.sandboxId, record.port, signal)) continue;
        await boat.hidePreview(resource.sandboxId, record.port, signal);
        await bb.storage.kv.delete(key);
      } catch { bb.log.warn("Boat preview cleanup could not finish; it will retry next minute."); }
    }
  }
  return { open, stop, reconcile };
}
