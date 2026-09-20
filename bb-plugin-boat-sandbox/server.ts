import { previews, parsePreviewArgs } from "./preview.js";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { Boat, resolveCli, stoppedStates } from "./boat.js";
import { configSchema, settingsDescriptors, developmentDefaults, providerId, resourceSchema } from "./config.js";
import { lifecycle, idleKey, ownedClient, type BoatFactory } from "./lifecycle.js";

export function createPlugin(factory?: BoatFactory) {
  return async (bb: BbPluginApi) => {
    const settings = bb.settings.define(settingsDescriptors);
    const config = async () => configSchema.parse(await settings.get());
    const lifetime = new AbortController();
    bb.onDispose(() => lifetime.abort());
    const client: BoatFactory = factory ?? (async (scope) => new Boat(await resolveCli((await config()).cliPath), scope));
    const preview = previews(bb, client, lifetime.signal);
    const machines = lifecycle(bb, config, client, lifetime.signal);
    bb.experimental_machines.register(machines.definition);
    bb.experimental_environments.register({
      id: providerId, displayName: "Boat sandbox", icon: "Ship",
      description: "Start a Boat machine and check out this project with BB.",
      machineProviderId: providerId, environmentProviderId: "project-checkout",
    });

    async function touch(hostId: string) {
      const host = await bb.sdk.hosts.get({ hostId });
      if (host.machineProviderId === providerId && host.lifecycle.phase === "active") await bb.storage.kv.set(idleKey(hostId), Date.now());
    }
    bb.events.on("experimental_terminal.input", async ({ terminal }) => touch(terminal.hostId));
    bb.events.on("experimental_thread.events", async ({ thread }) => {
      if (!["starting", "active"].includes(thread.status)) return;
      if (thread.environmentId) {
        await touch((await bb.sdk.environments.get({ environmentId: thread.environmentId })).hostId);
      } else {
        for (const host of await bb.sdk.hosts.list()) {
          if (host.machineProviderId !== providerId || host.lifecycle.phase !== "active") continue;
          const resource = resourceSchema.safeParse(await bb.experimental_machines.getResource(host.id));
          if (resource.success && resource.data.key === thread.id) await touch(host.id);
        }
      }
    });
    let sweeping = false;
    bb.background.schedule("maintain-boat-machines", "* * * * *", async () => {
      if (sweeping) return;
      sweeping = true;
      try {
        await preview.reconcile();
        const current = await config();
        for (const host of await bb.sdk.hosts.list()) {
          if (host.machineProviderId !== providerId || host.lifecycle.phase !== "active") continue;
          try {
            const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(45_000)]);
            const resource = resourceSchema.parse(await bb.experimental_machines.getResource(host.id));
            const boat = await ownedClient(client, resource, signal);
            const state = await boat.info(resource.sandboxId, signal);
            // Mirror an external TTL stop into BB so queued work invokes resume.
            if (stoppedStates.has(state.state)) {
              await bb.sdk.hosts.experimental_suspend({ hostId: host.id });
              continue;
            }
            const last = await bb.storage.kv.get<number>(idleKey(host.id));
            if (last === undefined) await bb.storage.kv.set(idleKey(host.id), Date.now());
            // Core may drain work for five minutes or reject with machine_busy.
            // Renew before requesting pause so neither races Boat's TTL.
            const expires = state.archiveAfter ? Date.parse(state.archiveAfter) : NaN;
            if (!Number.isFinite(expires) || expires < Date.now() + 15 * 60_000) await boat.extend(resource.sandboxId, resource.ttlSeconds, signal);
            if (current.idleMinutes > 0 && last !== undefined && Date.now() >= last + current.idleMinutes * 60_000) {
              await bb.sdk.hosts.experimental_suspend({ hostId: host.id });
            }
          } catch (error) {
            if (lifetime.signal.aborted) return;
            if (error && typeof error === "object" && "code" in error && error.code === "machine_busy") continue;
            bb.log.warn(`Boat maintenance failed for ${host.id}; it will retry next minute. Run bb boat inspect ${host.id}.`);
          }
        }
      } finally { sweeping = false; }
    });

    const usage = [
      "bb boat dev [--thread <id>] [--port <port>] [--daemon <name>] [--command <command>] [--url] [--json]",
      "bb boat preview [--thread <id>] [--port <port>] [--daemon <name>] [--url] [--json]",
      "bb boat preview-stop [--thread <id>] [--json]",
      "bb boat share [--thread <id>] [--port <port>] [--daemon <name>] [--command <command>] [--browser-host <id>] [--browser-instance <id>] [--url] [--json]",
      "bb boat doctor [--json]",
      "bb boat inspect <machine-id> [--json]",
      "bb boat allocations [--json]",
      "bb boat recover <allocation-key> <sandbox-id>",
      "bb boat clear-pending <allocation-key> --confirmed-no-sandbox",
      "Create/sleep/wake/remove machines with BB's machine commands or Machines page.",
    ].join("\n");
    bb.cli.register({
      name: "boat", summary: "Check Boat configuration and inspect sandbox lifecycle state",
      commands: [
        { name: "dev", summary: "Start development in a BB terminal, wait for the app and open its protected Boat preview", usage: "bb boat dev [--thread <id>] [--port <1-65535>] [--daemon <name>] [--command <shell-command>] [--browser-host <id>] [--browser-instance <id>] [--url] [--json]" },
        { name: "preview", summary: "Open a running app; --url explicitly returns its private sharing link", usage: "bb boat preview [--thread <id>] [--port <1-65535>] [--daemon <name>] [--browser-host <id>] [--browser-instance <id>] [--url] [--json]" },
        { name: "preview-stop", summary: "Hide this environment's plugin-created preview routes without stopping development", usage: "bb boat preview-stop [--thread <id>] [--json]" },
        { name: "share", summary: "Share a running app, or start one with --command, and open its private preview", usage: "bb boat share [--thread <id>] [--port <1-65535>] [--daemon <name>] [--command <command>] [--browser-host <id>] [--browser-instance <id>] [--url] [--json]" },
        { name: "doctor", summary: "Check CLI, login, start limits and snapshot retention", usage: "bb boat doctor [--json]" },
        { name: "inspect", summary: "Inspect the Boat resource belonging to a BB machine", usage: "bb boat inspect <machine-id> [--json]" },
        { name: "allocations", summary: "List tracked and uncertain Boat allocations", usage: "bb boat allocations [--json]" },
        { name: "recover", summary: "Recover an uncertain allocation after verifying its sandbox marker", usage: "bb boat recover <allocation-key> <sandbox-id>" },
        { name: "clear-pending", summary: "Clear an uncertain allocation after confirming no sandbox remains", usage: "bb boat clear-pending <allocation-key> --confirmed-no-sandbox" },
      ],
      async run(argv, context) {
        const json = argv.includes("--json");
        const [command, ...args] = argv.filter((arg) => arg !== "--json");
        const signal = context.signal ? AbortSignal.any([context.signal, lifetime.signal]) : lifetime.signal;
        const reply = (data: unknown) => ({ exitCode: 0, stdout: JSON.stringify(data, null, json ? undefined : 2) });
        if (!command || ["help", "--help"].includes(command)) return { exitCode: 0, stdout: usage };
        try {
          switch (command) {
            case "preview-stop": {
              if (args.length && (args.length !== 2 || args[0] !== "--thread")) break;
              const threadId = args[1] ?? context.threadId;
              if (!threadId) throw new Error("Run this in a BB thread, or pass --thread <id>.");
              return reply(await preview.stop(threadId, signal));
            }
            case "dev":
            case "preview":
            case "share": {
              const explicitStart = command === "dev" || (command === "share" && args.includes("--command"));
              const explicit = parsePreviewArgs(args, context.threadId, explicitStart);
              const thread = await bb.sdk.threads.get({ threadId: explicit.threadId });
              const defaults = developmentDefaults(await config(), thread.projectId);
              const start = explicitStart || (command === "share" && Boolean(defaults.command));
              const options = parsePreviewArgs(args, context.threadId, start, defaults);
              if (command !== "share") return reply(await preview.open(options, signal));
              const result = await preview.open({ ...options, includeUrl: json || options.includeUrl }, signal);
              if (json) return reply(result);
              if (options.includeUrl) return { exitCode: 0, stdout: result.url! };
              return { exitCode: 0, stdout: `${result.origin}/\n${result.message}\nAccess token withheld; use --url or --json to retrieve the private link.` };
            }
            case "doctor": {
              if (args.length) break;
              const current = await config();
              const boat = await client(current.scope);
              await boat.preflight(signal);
              return reply({ ok: true, cli: boat.cli, scope: current.scope, environment: current.environment, snapshot: current.snapshot || null, machineType: current.machineType, ttlSeconds: current.ttlSeconds, idleMinutes: current.idleMinutes });
            }
            case "inspect": {
              if (args.length !== 1) break;
              const host = await bb.sdk.hosts.get({ hostId: args[0]! });
              if (host.machineProviderId !== providerId) throw new Error("That machine is not owned by Boat Sandboxes.");
              const resource = resourceSchema.parse(await bb.experimental_machines.getResource(host.id));
              return reply({ hostId: host.id, lifecycle: host.lifecycle.phase, ...resource, boat: await (await ownedClient(client, resource, signal)).info(resource.sandboxId, signal) });
            }
            case "allocations": {
              if (args.length) break;
              const allocations = await machines.allocations();
              return reply({ allocations: allocations.slice(0, 500), total: allocations.length });
            }
            case "recover":
              if (args.length !== 2) break;
              await machines.recover(args[0]!, args[1]!, signal);
              return reply({ recovered: true });
            case "clear-pending":
              if (args.length !== 2 || args[1] !== "--confirmed-no-sandbox") break;
              await machines.clearPending(args[0]!);
              return reply({ cleared: true });
          }
          return { exitCode: 1, stderr: usage };
        } catch (error) {
          const raw = error instanceof Error ? error.message : "Boat command failed.";
          const [message, hint] = raw.split("\nHint: ", 2);
          return json
            ? { exitCode: 1, stdout: JSON.stringify({ ok: false, error: { code: "boat_command_failed", message, ...(hint ? { hint } : {}) } }), stderr: message! }
            : { exitCode: 1, stderr: raw };
        }
      },
    });
  };
}
export default createPlugin();
