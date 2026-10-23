import "server-only"
import { clientIp } from "@/lib/client-ip"

// The payer's side of payment links (no sign-in). Route handlers and the pay page call the backend's
// public routes with the payer's address, so its rate limits count each payer, not this server.
const API_URL = process.env.API_URL ?? "http://localhost:4000"

/** The payer's address, for the backend's rate limits. Only the platform's own header is believed (lib/client-ip.ts). */
export const forwardedFor = clientIp

/** Calls a public backend route and hands back its status and JSON body unchanged. */
export async function publicApi(path: string, init: { method?: "GET" | "POST"; json?: unknown; clientIp?: string } = {}) {
  const headers: Record<string, string> = { Accept: "application/json" }
  if (init.json !== undefined) headers["Content-Type"] = "application/json"
  if (init.clientIp) headers["X-Forwarded-For"] = init.clientIp
  try {
    const res = await fetch(`${API_URL}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
      cache: "no-store",
    })
    const body = await res.json().catch(() => null)
    return { status: res.status, body }
  } catch {
    return { status: 503, body: { error: "We can't reach LinkPay right now. Check your connection and try again.", code: "API_UNREACHABLE" } }
  }
}

/** JSON for the payer's browser: never cached, never indexed. */
export const payJson = (body: unknown, status: number) =>
  Response.json(body, { status, headers: { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" } })
