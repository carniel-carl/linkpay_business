// The visitor's IP address, which this server passes to the API so its rate limits count each visitor rather than
// this server. Browsers can send any header themselves, so only one that the platform in front of this server sets,
// replacing whatever the browser sent, is believed. CLIENT_IP_HEADER names it: "x-real-ip" or "x-forwarded-for" on
// Vercel, "cf-connecting-ip" behind Cloudflare, or the header your own proxy sets (nginx: `proxy_set_header
// X-Real-IP $remote_addr`). Unset, nothing is passed on.
//
// The API believes it in either of two ways (backend/src/middleware/clientIp.ts):
// - X-Forwarded-For, when the API's TRUST_PROXY lists this server's address (a fixed host, or a proxy in between);
// - X-LinkPay-Client-IP with X-LinkPay-Client-Secret, when CLIENT_IP_SECRET is set here to the API's own value.
//   That's for hosts with no fixed outgoing addresses to list, such as Vercel. Server-only: never NEXT_PUBLIC_.
// Both are sent, so either works.
const HEADER = process.env.CLIENT_IP_HEADER?.trim().toLowerCase()

const IP = /^[0-9a-f.:]{2,45}$/i

let warned = false

export function clientIp(headers: Headers): string | undefined {
  if (!HEADER) {
    if (process.env.NODE_ENV === "production" && !warned) {
      warned = true
      console.warn("CLIENT_IP_HEADER isn't set: the API sees every visitor as this server, so they share its rate limits.")
    }
    return undefined
  }
  // A proxy that appends to X-Forwarded-For puts the address it saw last; anything before it came from the browser.
  const ip = headers.get(HEADER)?.split(",").at(-1)?.trim()
  return ip && IP.test(ip) ? ip : undefined
}

const SECRET = process.env.CLIENT_IP_SECRET?.trim() || undefined
// The API's rule (backend/src/config/env.ts): it can't match anything shorter, and a header can't carry anything else.
const USABLE_SECRET = /^[\x21-\x7e]{32,}$/

function originOf(url: string) {
  try {
    return new URL(url).origin
  } catch {
    return undefined
  }
}

// The secret goes only to the API, never to any other address a caller might fetch.
const API_ORIGIN = originOf(process.env.API_URL ?? "http://localhost:4000")

let secretWarned = false

function clientIpSecret() {
  if (SECRET && USABLE_SECRET.test(SECRET)) return SECRET
  if (!secretWarned && (SECRET || process.env.NODE_ENV === "production")) {
    secretWarned = true
    console.warn(
      SECRET
        ? "CLIENT_IP_SECRET isn't usable (at least 32 characters, no spaces), so it isn't sent: the API believes visitors' addresses only if its TRUST_PROXY lists this server."
        : "CLIENT_IP_SECRET isn't set: the API believes visitors' addresses only if its TRUST_PROXY lists this server, which it can't on a host without fixed outgoing addresses (Vercel).",
    )
  }
  return undefined
}

/**
 * The headers that pass the visitor's address `ip` (from clientIp) to the API at `url`: X-Forwarded-For, and with
 * CLIENT_IP_SECRET, X-LinkPay-Client-IP and X-LinkPay-Client-Secret, only when `url` is on API_URL. Every API call
 * made for a visitor adds these.
 */
export function forwardIpHeaders(ip: string | undefined, url: string): Record<string, string> {
  const secret = clientIpSecret()
  if (!ip) return {}
  const headers: Record<string, string> = { "X-Forwarded-For": ip }
  if (secret && API_ORIGIN && originOf(url) === API_ORIGIN) {
    headers["X-LinkPay-Client-IP"] = ip
    headers["X-LinkPay-Client-Secret"] = secret
  }
  return headers
}
