import "server-only"
import { headers as requestHeaders } from "next/headers"
import { unstable_rethrow } from "next/navigation"
import { clientIp, forwardIpHeaders } from "@/lib/client-ip"
import { getSessionToken } from "@/lib/session"
import { ApiError } from "./errors"

const API_URL = process.env.API_URL ?? "http://localhost:4000"

type Method = "GET" | "POST" | "PATCH" | "DELETE"

type RequestOptions = {
  method?: Method
  json?: unknown
  /** Send the staff session token. Defaults to true; sign-in endpoints pass false. */
  auth?: boolean
}

const authHeader = (token: string | null): Record<string, string> => (token ? { Authorization: `Bearer ${token}` } : {})

/**
 * The staff member's address and browser for a call to `url`, so the API's sign-in limits count each person rather
 * than this server.
 */
async function visitorHeaders(url: string): Promise<Record<string, string>> {
  try {
    const incoming = await requestHeaders()
    const userAgent = incoming.get("user-agent")
    return { ...forwardIpHeaders(clientIp(incoming), url), ...(userAgent && { "User-Agent": userAgent }) }
  } catch (err) {
    // Next's own signals (such as prerendering bailing out) go on up; outside a request there's nothing to forward.
    unstable_rethrow(err)
    return {}
  }
}

/** Server-side fetch to the backend. Throws ApiError for non-2xx responses. */
export async function api<T>(path: string, { method = "GET", json, auth = true }: RequestOptions = {}) {
  const token = auth ? await getSessionToken() : null
  const url = `${API_URL}${path}`
  const headers: Record<string, string> = { Accept: "application/json", ...(await visitorHeaders(url)), ...authHeader(token) }
  if (json !== undefined) headers["Content-Type"] = "application/json"

  let res: Response
  try {
    res = await fetch(url, {
      method,
      headers,
      body: json !== undefined ? JSON.stringify(json) : undefined,
      cache: "no-store",
    })
  } catch {
    throw new ApiError(503, "We can't reach the LinkPay API right now. Check it's running and try again.", "API_UNREACHABLE")
  }

  // 204 No Content has no body.
  const body = res.status === 204 ? null : await res.json().catch(() => null)
  if (!res.ok) {
    throw new ApiError(res.status, body?.error ?? res.statusText ?? "Request failed", body?.code, body?.details, body?.missing, !!token)
  }
  return body as T
}

/** Streams a file from the backend with the session token (used by the document proxy route). */
export async function apiFile(path: string) {
  return fetch(`${API_URL}${path}`, { headers: authHeader(await getSessionToken()), cache: "no-store" })
}

/**
 * Opens the backend's notification stream (Server-Sent Events) with the session token. The caller passes
 * the browser's abort signal so the upstream connection closes when the tab does.
 */
export async function apiStream(path: string, { lastEventId, signal }: { lastEventId?: string | null; signal: AbortSignal }) {
  const headers: Record<string, string> = { Accept: "text/event-stream", ...authHeader(await getSessionToken()) }
  if (lastEventId) headers["Last-Event-ID"] = lastEventId
  return fetch(`${API_URL}${path}`, { headers, cache: "no-store", signal })
}
