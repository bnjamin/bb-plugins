import { setTimeout as delay } from "node:timers/promises";
import { BoatCommandError } from "./errors.js";

export const BOAT_API_URL = "https://boat.dev/api/v1";
const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_ATTEMPTS = 3;

export interface RestRequest {
  signal: AbortSignal;
  body?: unknown;
  headers?: Record<string, string>;
  // Bill to this plugin's scope. Calls by sandbox ID need no scope.
  scoped?: boolean;
  // Safe to repeat after a lost response or a transient failure.
  idempotent?: boolean;
  // Defaults to 30 seconds; slow lifecycle calls pass more.
  timeoutMs?: number;
}

// The Boat REST API. Responses have the same shapes as the CLI's --json
// output, so callers parse both with the same schemas.
export class BoatRest {
  constructor(private readonly apiKey: string, readonly scope: string, private readonly fetchImpl: typeof fetch = fetch, readonly retryDelayMs = 1000, private readonly baseUrl = BOAT_API_URL) {}

  async request(operation: string, method: string, path: string, options: RestRequest): Promise<unknown> {
    for (let attempt = 1; ; attempt += 1) {
      options.signal.throwIfAborted();
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            accept: "application/json",
            ...(options.body === undefined ? {} : { "content-type": "application/json" }),
            ...(options.scoped ? { "x-boat-org": this.scope } : {}),
            ...options.headers,
          },
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS)]),
        });
      } catch (error) {
        options.signal.throwIfAborted();
        // Network failure: the request may or may not have arrived.
        if (options.idempotent && attempt < RETRY_ATTEMPTS) { await delay(this.retryDelayMs * attempt, undefined, { signal: options.signal }); continue; }
        throw new BoatCommandError(operation, false, false, "network_error", { cause: error });
      }
      const data: unknown = await response.json().catch(() => null);
      if (response.ok) return data;
      const code = errorCode(data);
      const retryable = response.status >= 500 || code === "IP_RATE_LIMIT_EXCEEDED";
      if (options.idempotent && retryable && attempt < RETRY_ATTEMPTS) { await delay(this.retryDelayMs * attempt, undefined, { signal: options.signal }); continue; }
      throw new BoatCommandError(operation, response.status === 404 || code === "not_found", false, code ?? `http_${response.status}`);
    }
  }
  get(operation: string, path: string, signal: AbortSignal, scoped = false) {
    return this.request(operation, "GET", path, { signal, scoped, idempotent: true });
  }
}

// Error bodies may carry secrets; keep only the structured code.
function errorCode(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const record = data as { code?: unknown; error?: { code?: unknown } };
  const candidate = record.code ?? record.error?.code;
  return typeof candidate === "string" && /^[A-Za-z_]+$/.test(candidate) ? candidate : undefined;
}
