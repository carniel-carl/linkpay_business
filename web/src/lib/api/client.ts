import "server-only"
import { headers as requestHeaders } from "next/headers"
import { unstable_rethrow } from "next/navigation"
import { getBusinessCookie, setBusinessCookie } from "@/lib/business-context"
import { clientIp } from "@/lib/client-ip"
import { getSessionToken } from "@/lib/session"
import { ApiError } from "./errors"

const API_URL = process.env.API_URL ?? "http://localhost:4000"

type Method = "GET" | "POST" | "PATCH" | "DELETE"

type RequestOptions = {
  method?: Method
  json?: unknown
  form?: FormData
  /** Send the session token. Defaults to true; auth endpoints pass false. */
  auth?: boolean
  /** Extra headers, e.g. `Idempotency-Key` on transfers. */
  headers?: Record<string, string>
  /** Acts on this business instead of the one in the cookie (leaving the business a page showed). */
  businessId?: string
}

/** The business in the cookie is no longer one the user can act on (removed, or a stale id). */
const STALE_BUSINESS = new Set(["NOT_A_MEMBER", "INVALID_BUSINESS_ID"])

/** Drops the stale business choice. Server Components can't change cookies; the dashboard layout clears it then. */
async function forgetBusiness() {
  try {
    await setBusinessCookie(null)
  } catch {
    // Rendering a Server Component: see ClearStaleBusiness.
  }
}

/**
 * The visitor's address and browser, so the API's rate limits count each visitor rather than this server, and
 * its sessions list shows the browser.
 */
async function visitorHeaders(): Promise<Record<string, string>> {
  try {
    const incoming = await requestHeaders()
    const ip = clientIp(incoming)
    const userAgent = incoming.get("user-agent")
    return { ...(ip && { "X-Forwarded-For": ip }), ...(userAgent && { "User-Agent": userAgent }) }
  } catch (err) {
    // Next's own signals (such as prerendering bailing out) go on up; outside a request there's nothing to forward.
    unstable_rethrow(err)
    return {}
  }
}

function headersFor(token: string | null, businessId: string | null): Record<string, string> {
  return {
    ...(token && { Authorization: `Bearer ${token}` }),
    ...(token && businessId && { "X-Business-Id": businessId }),
  }
}

async function request<T>(
  path: string,
  method: Method,
  token: string | null,
  businessId: string | null,
  json?: unknown,
  form?: FormData,
  extra?: Record<string, string>,
) {
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(await visitorHeaders()),
    ...extra,
    ...headersFor(token, businessId),
  }
  if (json !== undefined) headers["Content-Type"] = "application/json"

  let res: Response
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      headers,
      body: form ?? (json !== undefined ? JSON.stringify(json) : undefined),
      cache: "no-store",
    })
  } catch {
    throw new ApiError(503, "We can't reach LinkPay right now. Check your connection and try again.", "API_UNREACHABLE")
  }

  // 204 No Content has no body.
  const body = res.status === 204 ? null : await res.json().catch(() => null)
  if (!res.ok) {
    throw new ApiError(
      res.status,
      body?.error ?? res.statusText ?? "Request failed",
      body?.code,
      body?.details,
      body?.missing,
      !!token,
    )
  }
  return body as T
}

/**
 * Server-side fetch to the backend. Throws ApiError for non-2xx responses.
 * Signed-in requests carry the chosen business as `X-Business-Id` (see lib/business-context.ts).
 */
export async function api<T>(path: string, { method = "GET", json, form, auth = true, headers, businessId: given }: RequestOptions = {}) {
  const token = auth ? await getSessionToken() : null
  const businessId = token ? (given ?? (await getBusinessCookie())) : null
  try {
    return await request<T>(path, method, token, businessId, json, form, headers)
  } catch (err) {
    // A business named by the caller isn't the cookie's choice, so there's no stale choice to drop or fall back from.
    if (given || !businessId || !(err instanceof ApiError) || !err.code || !STALE_BUSINESS.has(err.code)) throw err
    await forgetBusiness()
    // Reads fall back to the user's default business. Writes never do: they were meant for the
    // business that's gone, and repeating them elsewhere could change the wrong business.
    if (method !== "GET") throw err
    return request<T>(path, method, token, null, json, form, headers)
  }
}

/** Streams a file from the backend with the session token (used by the file proxy routes). */
export async function apiFile(path: string) {
  const token = await getSessionToken()
  const businessId = token ? await getBusinessCookie() : null
  const get = (id: string | null) => fetch(`${API_URL}${path}`, { headers: headersFor(token, id), cache: "no-store" })

  const res = await get(businessId)
  if (businessId && (res.status === 400 || res.status === 403)) {
    const code = await res
      .clone()
      .json()
      .then((b) => b?.code)
      .catch(() => undefined)
    if (STALE_BUSINESS.has(code)) {
      await forgetBusiness()
      return get(null)
    }
  }
  return res
}
