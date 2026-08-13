import type { AircallApi, Query, RequestOptions } from "./types.js";
import { VERSION } from "./version.js";

const AIRCALL_API_ORIGIN = "https://api.aircall.io";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RATE_LIMIT_RETRIES = 1;
const MAX_RETRY_DELAY_MS = 10_000;

export type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type SleepImplementation = (milliseconds: number, signal?: AbortSignal) => Promise<void>;

export interface AircallClientConfig {
  apiId: string;
  apiToken: string;
  timeoutMs?: number;
  maxRateLimitRetries?: number;
  fetchImplementation?: FetchImplementation;
  sleepImplementation?: SleepImplementation;
}

export class AircallApiError extends Error {
  readonly status: number;
  readonly path: string;

  constructor(message: string, status: number, path: string) {
    super(message);
    this.name = "AircallApiError";
    this.status = status;
    this.path = path;
  }
}

function validateCredentials(apiId: string, apiToken: string): void {
  if (!apiId.trim() || !apiToken.trim()) {
    throw new Error("AIRCALL_API_ID and AIRCALL_API_TOKEN are required.");
  }
  if (apiId.includes(":")) {
    throw new Error("AIRCALL_API_ID must not contain a colon.");
  }
}

function validatePath(path: string): void {
  const encodedPath = /^\/v[12]\/(?:[A-Za-z0-9_@.!~*'()\/-]|%[0-9A-Fa-f]{2})+$/;
  let decodedPath: string;

  try {
    decodedPath = decodeURIComponent(path);
  } catch {
    throw new Error(`Unsupported Aircall API path: ${path}`);
  }

  const hasDotSegment = decodedPath
    .split("/")
    .some((segment) => segment === "." || segment === "..");
  if (!encodedPath.test(path) || hasDotSegment) {
    throw new Error(`Unsupported Aircall API path: ${path}`);
  }
}

function buildUrl(path: string, query: Query = {}): URL {
  validatePath(path);
  const url = new URL(path, AIRCALL_API_ORIGIN);
  if (url.origin !== AIRCALL_API_ORIGIN || !/^\/v[12]\//.test(url.pathname)) {
    throw new Error(`Unsupported Aircall API path: ${path}`);
  }

  for (const [key, rawValue] of Object.entries(query)) {
    if (rawValue === undefined) continue;

    if (Array.isArray(rawValue)) {
      for (const item of rawValue) {
        url.searchParams.append(`${key}[]`, String(item));
      }
      continue;
    }

    url.searchParams.set(key, String(rawValue));
  }

  return url;
}

function parseApiError(body: string, status: number): string {
  const fallback = `Aircall API returned HTTP ${status}.`;
  if (!body) return fallback;

  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    for (const key of ["error_description", "troubleshoot", "message", "error"]) {
      const value = parsed[key];
      if (typeof value === "string" && value.trim()) {
        return `${fallback} ${value.trim().slice(0, 500)}`;
      }
    }
  } catch {
    // Fall through to a bounded plain-text response.
  }

  const bounded = body.replace(/\s+/g, " ").trim().slice(0, 500);
  return bounded ? `${fallback} ${bounded}` : fallback;
}

function retryDelayMilliseconds(headers: Headers): number {
  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1_000, MAX_RETRY_DELAY_MS);
    }

    const timestamp = Date.parse(retryAfter);
    if (Number.isFinite(timestamp)) {
      return Math.min(Math.max(timestamp - Date.now(), 0), MAX_RETRY_DELAY_MS);
    }
  }

  const reset = Number(headers.get("x-aircallapi-reset"));
  if (Number.isFinite(reset) && reset > 0) {
    return Math.min(Math.max(reset * 1_000 - Date.now(), 0), MAX_RETRY_DELAY_MS);
  }

  return 1_000;
}

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Request cancelled."));
      return;
    }

    const finish = (): void => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason ?? new Error("Request cancelled."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function requestSignal(parent: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  timedOut: () => boolean;
  cleanup: () => void;
} {
  const controller = new AbortController();
  let didTimeOut = false;

  const onParentAbort = (): void => {
    controller.abort(parent?.reason ?? new Error("Request cancelled."));
  };
  parent?.addEventListener("abort", onParentAbort, { once: true });
  if (parent?.aborted) onParentAbort();

  const timer = setTimeout(() => {
    didTimeOut = true;
    controller.abort(new Error(`Aircall API request timed out after ${timeoutMs}ms.`));
  }, timeoutMs);

  return {
    signal: controller.signal,
    timedOut: () => didTimeOut,
    cleanup: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParentAbort);
    },
  };
}

export class AircallClient implements AircallApi {
  private readonly authorization: string;
  private readonly timeoutMs: number;
  private readonly maxRateLimitRetries: number;
  private readonly fetchImplementation: FetchImplementation;
  private readonly sleepImplementation: SleepImplementation;

  constructor(config: AircallClientConfig) {
    validateCredentials(config.apiId, config.apiToken);

    this.authorization = `Basic ${Buffer.from(
      `${config.apiId}:${config.apiToken}`,
      "utf8",
    ).toString("base64")}`;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRateLimitRetries = config.maxRateLimitRetries ?? DEFAULT_RATE_LIMIT_RETRIES;
    this.fetchImplementation = config.fetchImplementation ?? ((input, init) => fetch(input, init));
    this.sleepImplementation = config.sleepImplementation ?? defaultSleep;

    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error("timeoutMs must be a positive integer.");
    }
    if (!Number.isInteger(this.maxRateLimitRetries) || this.maxRateLimitRetries < 0) {
      throw new Error("maxRateLimitRetries must be a non-negative integer.");
    }
  }

  async get<T = unknown>(
    path: string,
    query: Query = {},
    options: RequestOptions = {},
  ): Promise<T> {
    const url = buildUrl(path, query);

    for (let attempt = 0; attempt <= this.maxRateLimitRetries; attempt += 1) {
      const activeSignal = requestSignal(options.signal, this.timeoutMs);

      try {
        const response = await this.fetchImplementation(url, {
          method: "GET",
          redirect: "error",
          headers: {
            Accept: "application/json",
            Authorization: this.authorization,
            "User-Agent": `aircall-mcp/${VERSION}`,
          },
          signal: activeSignal.signal,
        });
        const body = await response.text();

        if (response.status === 429 && attempt < this.maxRateLimitRetries) {
          activeSignal.cleanup();
          await this.sleepImplementation(
            retryDelayMilliseconds(response.headers),
            options.signal,
          );
          continue;
        }

        if (!response.ok) {
          throw new AircallApiError(parseApiError(body, response.status), response.status, path);
        }

        if (!body) return {} as T;

        try {
          return JSON.parse(body) as T;
        } catch {
          throw new AircallApiError(
            "Aircall API returned a non-JSON response.",
            response.status,
            path,
          );
        }
      } catch (error) {
        if (error instanceof AircallApiError) throw error;
        if (activeSignal.timedOut()) {
          throw new Error(`Aircall API request timed out after ${this.timeoutMs}ms.`);
        }
        if (options.signal?.aborted) {
          throw new Error("Aircall API request was cancelled.");
        }
        throw error;
      } finally {
        activeSignal.cleanup();
      }
    }

    throw new Error("Aircall API request failed after rate-limit retries.");
  }
}
