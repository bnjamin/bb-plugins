import { previews, parsePreviewArgs } from "./preview.js";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { Boat, resolveCli, stoppedStates } from "./boat.js";
import { configSchema, settingsDescriptors, providerId, resourceSchema } from "./config.js";
import { lifecycle, idleKey, ownedClient, type BoatFactory } from "./lifecycle.js";
import { shareContract } from "./share-contract.js";
import { revealUrl } from "./browser.js";

export function createPlugin(factory?: BoatFactory) {
  return async (bb: BbPluginApi) => {
    const settings = bb.settings.define(settingsDescriptors);
    const config = async () => configSchema.parse(await settings.get());
    const lifetime = new AbortController();
    bb.onDispose(() => lifetime.abort());
    const client: BoatFactory = factory ?? (async (scope) => new Boat(await resolveCli((await config()).cliPath), scope));
    const preview = previews(bb, client, lifetime.signal);
    const machines = lifecycle(bb, config, client, lifetime.signal);
    const hostWorker = bb.hosts.experimental_client({ contract: shareContract });
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
      "bb boat share [--thread <id>] [--port <port>] [--browser-host <id>] [--browser-instance <id>] [--json]",
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
        { name: "share", summary: "Privately share the supported Sofia development server and open it in this thread's browser panel", usage: "bb boat share [--thread <id>] [--port <1-65535>] [--browser-host <id>] [--browser-instance <id>] [--json]" },
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
            case "dev":
            case "preview":
              return reply(await preview.open(parsePreviewArgs(args, context.threadId, command === "dev"), signal));
            case "preview-stop": {
              if (args.length && (args.length !== 2 || args[0] !== "--thread")) break;
              const threadId = args[1] ?? context.threadId;
              if (!threadId) throw new Error("Run this in a BB thread, or pass --thread <id>.");
              return reply(await preview.stop(threadId, signal));
            }
            case "share": {
              let threadId = context.threadId;
              let port = 3000;
              let browserHost: string | undefined;
              let browserInstance: string | undefined;
              for (let index = 0; index < args.length; index += 2) {
                const option = args[index];
                const value = args[index + 1];
                if (!value || !["--thread", "--port", "--browser-host", "--browser-instance"].includes(option!)) {
                  throw new Error("Usage: bb boat share [--thread <id>] [--port <1-65535>] [--browser-host <id>] [--browser-instance <id>].");
                }
                if (option === "--thread") threadId = value;
                else if (option === "--browser-host") browserHost = value;
                else if (option === "--browser-instance") browserInstance = value;
                else port = Number(value);
              }
              if (!threadId) throw new Error("Run this in a BB thread, or pass --thread <id>.");
              if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be an integer from 1 to 65535.");
              const thread = await bb.sdk.threads.get({ threadId });
              if (!thread.environmentId) throw new Error("This thread has no environment. Select a Boat sandbox first.");
              const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
              if (!environment.path) throw new Error("This environment has no working directory yet.");
              const host = await bb.sdk.hosts.get({ hostId: environment.hostId });
              if (host.machineProviderId !== providerId) throw new Error("This thread is not on a Boat machine.");
              if (host.status !== "connected" || host.lifecycle.phase !== "active") throw new Error("Resume the thread's Boat machine before sharing its development server.");
              const result = await hostWorker.call("share", { workspacePath: environment.path, port }, { hostId: environment.hostId, signal, timeoutMs: 120_000 });
              const { browser, matched } = await revealUrl(bb, result.url, { threadId, browserHost, browserInstance });
              const message = browser !== "unavailable"
                ? "Sofia is shared and open in this thread's browser panel. Select the thread to see it."
                : matched === null
                  ? "Sofia is shared, but BB could not open its browser. The private link is in this response."
                  : `Sofia is shared; ${matched} desktop windows matched. Select one with --browser-host/--browser-instance, or open the private link in this response.`;
              return reply({ ...result, browser, message });
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
