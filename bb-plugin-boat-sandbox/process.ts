import { spawn } from "node:child_process";

export interface RunOptions {
  signal: AbortSignal;
  timeoutMs?: number;
  stdin?: string;
  onLine?: (line: string) => Promise<void>;
  onOutput?: (chunk: string) => void;
}
export interface RunResult { exitCode: number; stdout: string; stderr: string }
export type Runner = (executable: string, args: string[], options: RunOptions) => Promise<RunResult>;

// No shell, bounded buffers, process-group cancellation (boat ssh spawns ssh).
// Commands carrying private stdin never forward output to progress logs.
export const run: Runner = async (executable, args, options) => {
  options.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: "pipe", detached: process.platform !== "win32" });
    let stdout = "", stderr = "", pending = "", bytes = 0;
    let failure: unknown;
    let lines = Promise.resolve();
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch { /* Process already exited. */ }
    };
    const stop = (error: unknown) => {
      failure ??= error;
      kill("SIGTERM");
      killTimer ??= setTimeout(() => kill("SIGKILL"), 1000);
    };
    const abort = () => stop(options.signal.reason ?? new Error("Boat command cancelled."));
    const timer = setTimeout(() => stop(new Error("Boat command timed out.")), options.timeoutMs ?? 60_000);
    options.signal.addEventListener("abort", abort, { once: true });
    const line = (value: string) => {
      if (!options.onLine || !value.trim()) return;
      lines = lines.then(() => options.onLine!(value)).catch(stop);
    };
    const output = (chunk: Buffer, stream: "stdout" | "stderr") => {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) { stop(new Error("Boat command exceeded the output limit.")); return; }
      const text = chunk.toString();
      if (stream === "stdout") {
        stdout += text;
        pending += text;
        let index: number;
        while ((index = pending.indexOf("\n")) !== -1) {
          line(pending.slice(0, index)); pending = pending.slice(index + 1);
        }
      } else stderr += text;
      if (!options.stdin) options.onOutput?.(text);
    };
    child.stdout.on("data", (chunk: Buffer) => output(chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => output(chunk, "stderr"));
    child.stdin.on("error", (error: NodeJS.ErrnoException) => { if (error.code !== "EPIPE") stop(error); });
    child.on("error", stop);
    child.on("close", (code) => {
      clearTimeout(timer); clearTimeout(killTimer);
      options.signal.removeEventListener("abort", abort);
      line(pending);
      void lines.then(() => {
        if (failure) reject(failure);
        else resolve({ exitCode: code ?? 1, stdout, stderr });
      });
    });
    if (options.signal.aborted) abort();
    child.stdin.end(options.stdin ?? "");
  });
};

export function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
