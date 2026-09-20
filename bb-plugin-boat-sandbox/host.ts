import { access, readFile, rename, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";
import { shareContract } from "./share-contract.js";

const timeoutMs = 90_000;
export const boatHostBinary = () => process.env.BB_BOAT_SHARE_HOST_BINARY ?? "/home/user/.ascii/host";

const redact = (text: string) => text
  .replace(/([?&](?:_?token|access_token)=)[^\s&]+/gi, "$1[redacted]")
  .replace(/\b(ASCII_TOKEN|authorization|bearer)\s*[:=]\s*\S+/gi, "$1=[redacted]");

export function safeStderrHint(stderr: string): string | undefined {
  const lines = stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return undefined;
  // mise prints the real failure above a generic "run with --verbose" footer, so
  // the literal last line is the one line that carries no information.
  const errors = lines.filter((line) => /(^|\s)(error|fatal)\b/i.test(line) && !/--verbose|MISE_VERBOSE/i.test(line));
  return redact((errors.length ? errors.slice(-2) : lines.slice(-3)).join(" | ")).slice(0, 500);
}

async function executable(command: string, args: string[], cwd: string, signal: AbortSignal, login = false): Promise<string> {
  return new Promise((resolve, reject) => {
    // Passing command and arguments after bash's $0 keeps the fixed wrapper
    // path and numeric port out of a shell command string.
    const child = login
      ? spawn("bash", ["-lc", "exec \"$@\"", "bash", command, ...args], { cwd, signal, env: { ...process.env, HOME: process.env.HOME ?? "/home/user" }, stdio: ["ignore", "pipe", "pipe"] })
      : spawn(command, args, { cwd, signal, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", () => reject(new Error(`Could not run ${command} in this Boat sandbox.`)));
    child.once("close", (code) => {
      const hint = safeStderrHint(stderr);
      code === 0
        ? resolve(stdout)
        : reject(new Error(`${command} failed while preparing the Sofia development server.${hint ? `\nHint: exited ${code ?? "unknown"}: ${hint}` : ""}`));
    });
  });
}

async function isSofiaLayout(workspacePath: string): Promise<boolean> {
  try {
    const [mise, script] = await Promise.all([
      readFile(join(workspacePath, "mise.toml"), "utf8"),
      access(join(workspacePath, "script", "dev-start.rb"), constants.F_OK),
    ]);
    return /\bdaemons\b/.test(mise) && ["rails", "js", "css"].every((daemon) => new RegExp(`\\b${daemon}\\b`).test(mise));
  } catch { return false; }
}

export function mergeDevelopmentEnv(current: string): string {
  const lines = current ? current.replace(/\r?\n$/, "").split(/\r?\n/) : [];
  const expected = new Map([["HOST", "0.0.0.0"]]);
  const seen = new Set<string>();
  const next = lines.map((line) => {
    const match = /^\s*(HOST)\s*=/.exec(line);
    if (!match) return line;
    const key = match[1]!;
    seen.add(key);
    return `${key}=${expected.get(key)!}`;
  });
  for (const [key, value] of expected) if (!seen.has(key)) next.push(`${key}=${value}`);
  return `${next.join("\n")}\n`;
}

async function repairDevelopmentEnv(workspacePath: string): Promise<boolean> {
  const path = join(workspacePath, ".env.development");
  let current = "";
  try { current = await readFile(path, "utf8"); } catch (error: unknown) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }
  const next = mergeDevelopmentEnv(current);
  if (next === current) return false;
  const temporary = `${path}.bb-boat-share-${process.pid}`;
  await writeFile(temporary, next, "utf8");
  await rename(temporary, path);
  return true;
}

async function waitForPort(port: number, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal.aborted) throw signal.reason;
    const accepting = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port });
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => { socket.destroy(); resolve(false); });
      socket.setTimeout(1_000, () => { socket.destroy(); resolve(false); });
    });
    if (accepting) return;
    await delay(1_000, undefined, { signal });
  }
  throw new Error(`Sofia did not accept connections on port ${port} within 90 seconds.`);
}

function startDetached(workspacePath: string): void {
  const child = spawn("ruby", ["script/dev-start.rb"], {
    cwd: workspacePath, detached: true, stdio: "ignore",
  });
  child.unref();
}

function privateUrl(output: string): string {
  const match = output.match(/https:\/\/[^\s]+/);
  if (!match) throw new Error("Boat host did not return a private HTTPS URL.");
  try {
    const url = new URL(match[0]);
    if (url.protocol !== "https:") throw new Error();
    return url.href;
  } catch { throw new Error("Boat host did not return a private HTTPS URL."); }
}

export default experimental_defineHostEntry({
  contract: shareContract,
  handlers: {
    share: async ({ workspacePath, port }, context) => {
      if (!(await isSofiaLayout(workspacePath))) {
        throw new Error("This workspace is not the supported Sofia layout: expected mise.toml daemons (rails, js, css) and script/dev-start.rb.");
      }
      const changed = await repairDevelopmentEnv(workspacePath);
      // Best effort: `mise daemons stop` exits non-zero when the supervisor is not
      // running, and from a clean workspace there is simply nothing to restart.
      if (changed) await executable("mise", ["daemons", "stop"], workspacePath, context.signal).catch(() => undefined);
      startDetached(workspacePath);
      await waitForPort(port, context.signal);
      const host = boatHostBinary();
      try { await access(host, constants.X_OK); } catch { throw new Error("Boat's sandbox host command is unavailable at /home/user/.ascii/host."); }
      await executable(host, [String(port), "--private", "--title", "BB Sofia development"], workspacePath, context.signal, true);
      const output = await executable(host, ["url", String(port), "--private"], workspacePath, context.signal, true);
      return { url: privateUrl(output) };
    },
  },
});
