import { API_URL } from "@/lib/config";
import { getAccessToken, invalidateAccessToken, refreshSession } from "@/lib/auth/session";
import { currentBusinessId, useBusinessContext } from "@/lib/business-context";
import { ApiError } from "./errors";

type Options = {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  json?: unknown;
  /** Sends the session's access token. Default true. */
  auth?: boolean;
  /** Sent as X-Business-Id. Defaults to the business picked in the switcher. */
  businessId?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Extra headers, e.g. Idempotency-Key on a transfer. */
  headers?: Record<string, string>;
};

async function send(path: string, opts: Options, token?: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000);
  opts.signal?.addEventListener("abort", () => controller.abort());
  try {
    return await fetch(`${API_URL}${path}`, {
      method: opts.method ?? (opts.json === undefined ? "GET" : "POST"),
      headers: {
        Accept: "application/json",
        ...(opts.json !== undefined && { "Content-Type": "application/json" }),
        ...(token && { Authorization: `Bearer ${token}` }),
        ...(opts.businessId && { "X-Business-Id": opts.businessId }),
        ...opts.headers,
      },
      body: opts.json === undefined ? undefined : JSON.stringify(opts.json),
      signal: controller.signal,
    });
  } catch {
    if (opts.signal?.aborted) throw new ApiError(0, "Cancelled", "CANCELLED");
    throw controller.signal.aborted
      ? new ApiError(0, "Request timed out", "TIMEOUT")
      : new ApiError(0, "Network request failed", "NETWORK");
  } finally {
    clearTimeout(timer);
  }
}

async function parse<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const body = text ? safeJson(text) : undefined;
  if (!res.ok) {
    const b = (body ?? {}) as { error?: string; code?: string; details?: unknown };
    throw new ApiError(res.status, b.error ?? (text || res.statusText), b.code, b.details);
  }
  return body as T;
}

function safeJson(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

/** Calls the LinkPay Business API. Refreshes the session once on an expired access token. */
export async function api<T = unknown>(path: string, opts: Options = {}): Promise<T> {
  if (opts.auth === false) return parse<T>(await send(path, opts));
  const picked = opts.businessId === undefined ? currentBusinessId() : undefined;
  if (picked) opts = { ...opts, businessId: picked };

  let res = await send(path, opts, await getAccessToken());
  if (res.status === 401) {
    const body = await res.clone().json().catch(() => ({}));
    // A revoked session can't be refreshed; the refresh call below reports it and signs out.
    if (body?.code === "INVALID_TOKEN" || body?.code === "SESSION_REVOKED") {
      invalidateAccessToken();
      res = await send(path, opts, await refreshSession());
    }
  }
  // Removed from the picked business: forget it, and repeat reads for the default business. Writes are
  // never repeated, since they would act on a different business.
  if (picked && (res.status === 403 || res.status === 404) && (opts.method ?? (opts.json === undefined ? "GET" : "POST")) === "GET") {
    const body = await res.clone().json().catch(() => ({}));
    if (body?.code === "NOT_A_MEMBER" || body?.code === "INVALID_BUSINESS_ID") {
      useBusinessContext.getState().setBusinessId(undefined);
      res = await send(path, { ...opts, businessId: undefined }, await getAccessToken());
    }
  }
  return parse<T>(res);
}
