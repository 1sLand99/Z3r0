import { clearStoredAccessToken, getStoredAccessToken } from "../auth/session";
import { ACCESS_TOKEN_HEADER } from "./generated/constants";
import type { CommonResponsePayload } from "./types";

type RequestOptions = {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  auth?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
};

type JsonRequestMethod = NonNullable<RequestOptions["method"]>;

type RawRequestOptions = {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  headers?: HeadersInit;
  body?: BodyInit;
  auth?: boolean;
  signal?: AbortSignal;
};

const QUERY_TIMEOUT_MS = 30_000;
const MUTATION_TIMEOUT_MS = 120_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;

export class ApiError extends Error {
  readonly status: number;
  readonly response?: CommonResponsePayload;

  constructor(status: number, response?: CommonResponsePayload) {
    super(response?.message || "Request failed");
    this.name = "ApiError";
    this.status = status;
    this.response = response;
  }
}

function isCommonResponsePayload(value: unknown): value is CommonResponsePayload {
  return typeof value === "object"
    && value !== null
    && "code" in value
    && typeof value.code === "number"
    && "message" in value
    && typeof value.message === "string";
}

async function parseJsonResponse(response: Response) {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    return undefined;
  }
  return response.json() as Promise<unknown>;
}

function parseCommonResponseError(response: Response, parsed: unknown) {
  const payload = isCommonResponsePayload(parsed) ? parsed : undefined;
  const payloadCode = typeof payload?.code === "number" ? payload.code : response.status;
  if (!response.ok || payloadCode >= 400) {
    handleAuthExpired(response.status, payloadCode);
    throw new ApiError(response.status, payload);
  }
}

export async function apiRequest<ResponsePayload>(path: string, options: RequestOptions = {}) {
  const headers = new Headers({ Accept: "application/json" });
  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }

  addAccessTokenHeader(headers, options.auth);

  const requestAbort = createRequestAbort(
    options.signal,
    options.timeoutMs ?? (options.method && options.method !== "GET" ? MUTATION_TIMEOUT_MS : QUERY_TIMEOUT_MS),
  );
  try {
    const response = await fetch(path, {
      method: options.method || "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: requestAbort.signal,
    });
    const parsed = await parseJsonResponse(response);
    parseCommonResponseError(response, parsed);
    return parsed as ResponsePayload;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (isAbortError(error)) throw error;
    throw new ApiError(0, {
      code: 0,
      message: error instanceof Error ? error.message : "Network request failed",
    });
  } finally {
    requestAbort.dispose();
  }
}

export function defineJsonEndpoint<Args extends unknown[], ResponsePayload>(
  method: JsonRequestMethod,
  path: (...args: Args) => string,
  body?: (...args: Args) => unknown,
  auth?: boolean,
) {
  return (...args: Args) => apiRequest<ResponsePayload>(path(...args), {
    method,
    body: body?.(...args),
    auth,
  });
}

async function rawApiRequest(path: string, options: RawRequestOptions = {}) {
  const headers = new Headers(options.headers);
  addAccessTokenHeader(headers, options.auth);

  try {
    return await fetch(path, {
      method: options.method || "GET",
      headers,
      body: options.body,
      signal: options.signal,
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new ApiError(0, {
      code: 0,
      message: error instanceof Error ? error.message : "Network request failed",
    });
  }
}

export async function apiForm<ResponsePayload>(path: string, body: FormData, auth = true) {
  const requestAbort = createRequestAbort(undefined, MUTATION_TIMEOUT_MS);
  try {
    const response = await rawApiRequest(path, {
      method: "POST",
      headers: { Accept: "application/json" },
      body,
      auth,
      signal: requestAbort.signal,
    });
    const parsed = await parseJsonResponse(response);
    parseCommonResponseError(response, parsed);
    return parsed as ResponsePayload;
  } finally {
    requestAbort.dispose();
  }
}

export async function apiBlob(path: string, auth = true) {
  const requestAbort = createRequestAbort(undefined, DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await rawApiRequest(path, { auth, signal: requestAbort.signal });
    if (!response.ok) {
      const parsed = await parseJsonResponse(response);
      parseCommonResponseError(response, parsed);
      throw new ApiError(response.status);
    }
    return {
      blob: await response.blob(),
      filename: parseContentDispositionFilename(response.headers.get("content-disposition")),
    };
  } finally {
    requestAbort.dispose();
  }
}

function handleAuthExpired(status: number, payloadCode: number) {
  if (status !== 401 && payloadCode !== 401) return;
  clearStoredAccessToken();
  window.dispatchEvent(new Event("z3r0:auth-expired"));
}

export function buildAuthenticatedWebSocketUrl(path: string, token = getStoredAccessToken()) {
  if (!token) throw new Error("missing access token");
  const wsScheme = window.location.protocol === "https:" ? "wss" : "ws";
  return `${wsScheme}://${window.location.host}${path}?token=${encodeURIComponent(token)}`;
}

export function isAbortError(error: unknown): boolean {
  return (error instanceof DOMException && error.name === "AbortError")
    || (typeof error === "object" && error !== null && Reflect.get(error, "name") === "AbortError");
}

export function composeAbortSignals(signals: readonly (AbortSignal | undefined)[]): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const removers: Array<() => void> = [];
  const abortFrom = (signal: AbortSignal) => {
    if (!controller.signal.aborted) controller.abort(signal.reason);
  };
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      abortFrom(signal);
      break;
    }
    const onAbort = () => abortFrom(signal);
    signal.addEventListener("abort", onAbort, { once: true });
    removers.push(() => signal.removeEventListener("abort", onAbort));
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const remove of removers) remove();
    },
  };
}

function createRequestAbort(signal: AbortSignal | undefined, timeoutMs: number) {
  const timeoutController = new AbortController();
  const timer = window.setTimeout(() => {
    timeoutController.abort(new DOMException(`Request timed out after ${timeoutMs} ms`, "TimeoutError"));
  }, timeoutMs);
  const composed = composeAbortSignals([signal, timeoutController.signal]);
  return {
    signal: composed.signal,
    dispose: () => {
      window.clearTimeout(timer);
      composed.dispose();
    },
  };
}

function addAccessTokenHeader(headers: Headers, auth = true) {
  if (!auth) return;
  const token = getStoredAccessToken();
  if (token) {
    headers.set(ACCESS_TOKEN_HEADER, token);
  }
}

function parseContentDispositionFilename(header: string | null) {
  if (!header) return "download";
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (encoded?.[1]) {
    try {
      return decodeURIComponent(encoded[1]);
    } catch {
      return encoded[1];
    }
  }
  const quoted = /filename="([^"]+)"/i.exec(header);
  if (quoted?.[1]) return quoted[1];
  return "download";
}
