import { NextResponse, type NextRequest } from "next/server"
import { clientIp } from "@/lib/client-ip"
import { safeNext } from "@/lib/safe-next"

// Auth-state guard only. Business-status routing happens on the server with GET /api/business,
// because the proxy can't verify the JWT or see the business.
const SESSION_COOKIE = "lp_session"
const CHALLENGE_COOKIE = "lp_2fa"

const AUTH_ROUTES = ["/sign-in", "/sign-up", "/verify-email"]
// Open to everyone, signed in or not. Invite links work either way: the page decides what to show.
// /i/ is a customer's invoice (page, PDF and logo) and /pay/ a payment link: payers never have an account.
// /embed.js is the script businesses put on their own websites. Password reset is also how a signed-in
// account with no password sets one (Settings, Security).
const PUBLIC_ROUTES = ["/", "/embed.js", "/forgot-password", "/reset-password"]
const PUBLIC_PREFIXES = ["/invite/", "/i/", "/pay/"]
const HOME = "/dashboard"

const API_URL = process.env.API_URL ?? "http://localhost:4000"
const PAY_PAGE = /^\/pay\/([a-z0-9-]{6,40})\/?$/
// Files, not pages, so they keep next.config.ts's headers only: embed.js runs on businesses' websites under their
// own policy, and an invoice PDF opens in the browser's PDF viewer, with no page scripts for a policy to govern.
const NOT_PAGES = /^\/(embed\.js|i\/[^/]+\/pdf)$/

const DEV = process.env.NODE_ENV === "development"
// CSP_REPORT_ONLY=1 reports what the policy would block instead of blocking it, to roll it out safely; next.config.ts
// keeps frame-ancestors 'none' enforced meanwhile. /pay/* always enforces: its frame-ancestors has to be enforced
// from here, Next copies this proxy's response headers onto the request, and it reads the nonce from the enforced
// policy first, so a report-only one there would leave Next's scripts without it.
const REPORT_ONLY = process.env.CSP_REPORT_ONLY === "1"

/**
 * The Content-Security-Policy for a page. Scripts run only with this request's nonce, and what they load from
 * there ('strict-dynamic'); 'self' is for browsers older than CSP 3. Everything is loaded from this server: logos
 * and link pictures come through its own routes, and the browser talks only to it (the API is server-side).
 */
function contentSecurityPolicy(nonce: string, frameAncestors: string, https: boolean) {
  return [
    "default-src 'self'",
    // React uses eval for its debugging information in development only.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${DEV ? " 'unsafe-eval'" : ""}`,
    // React renders style attributes, and Sonner and Radix (its scroll lock) add <style> elements with no nonce.
    "style-src 'self' 'unsafe-inline'",
    // QR codes are data: URLs, and pictures being uploaded are previewed from blob: URLs.
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    `frame-ancestors ${frameAncestors}`,
    // Over HTTPS only (X-Forwarded-Proto behind a proxy): on plain http, as with `next start` locally, browsers
    // would also upgrade redirects to https and fail them.
    ...(https ? ["upgrade-insecure-requests"] : []),
  ].join("; ")
}

/**
 * On to the page with a fresh nonce in its policy. The policy also goes on the request: Next reads the nonce from
 * there for its own scripts, and the root layout reads x-nonce for next-themes. `pay`: a /pay/ path's frame-ancestors.
 */
function proceed(request: NextRequest, pay?: string) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64")
  const policy = contentSecurityPolicy(nonce, pay ?? "'none'", request.nextUrl.protocol === "https:")
  const headers = new Headers(request.headers)
  headers.set("x-nonce", nonce)
  headers.set("Content-Security-Policy", policy)
  const response = NextResponse.next({ request: { headers } })
  response.headers.set(REPORT_ONLY && !pay ? "Content-Security-Policy-Report-Only" : "Content-Security-Policy", policy)
  return response
}

/**
 * The path as the router sees it: "/pay/%6Dyshop-1" renders the page for "myshop-1", so it gets that link's
 * rules. Decoded once, like Next decodes the slug; a malformed escape stays as it is (and matches no link).
 */
function decodePath(pathname: string) {
  try {
    return decodeURIComponent(pathname)
  } catch {
    return pathname
  }
}

// A link's allowed websites, briefly remembered so a page and its follow-up requests don't each ask.
const framers = new Map<string, { at: number; value: string }>()
const FRAMERS_TTL_MS = 30_000

/**
 * Who may show a payment-link page in a frame: the link's allowed websites, or any site when it has none
 * (docs/briefs/payment-links.md §5). Unknown links get 'self' only; the page itself says "not found".
 */
async function frameAncestors(slug: string, visitorIp: string | undefined) {
  const hit = framers.get(slug)
  if (hit && Date.now() - hit.at < FRAMERS_TTL_MS) return hit.value
  let value = "'self'"
  try {
    const res = await fetch(`${API_URL}/api/public/pay/${slug}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(3000),
      // The payer's address, so the backend's rate limit counts them and not this server.
      headers: visitorIp ? { "X-Forwarded-For": visitorIp } : undefined,
    })
    if (res.ok) {
      const body = (await res.json()) as { embed?: { allowedOrigins?: string[] } }
      const allowed = (body.embed?.allowedOrigins ?? []).filter((o) => /^https?:\/\/[a-z0-9.*:[\]-]+$/i.test(o))
      value = allowed.length ? ["'self'", ...allowed].join(" ") : "*"
    }
  } catch {
    // Backend unreachable: the page will show its own error; don't let other sites frame it meanwhile.
  }
  framers.set(slug, { at: Date.now(), value })
  if (framers.size > 1000) framers.delete(framers.keys().next().value!)
  return value
}

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl
  const signedIn = request.cookies.has(SESSION_COOKIE)
  const isAuthRoute = AUTH_ROUTES.some((r) => pathname === r || pathname.startsWith(`${r}/`))

  // Everything under /pay/ gets frame-ancestors here (next.config.ts leaves these paths to the proxy): the
  // link's allowed websites on its page, and 'self' on anything else, so no spelling of a path escapes it.
  const decoded = decodePath(pathname)
  if (decoded.startsWith("/pay/")) {
    const pay = PAY_PAGE.exec(decoded)
    const ancestors = pay ? await frameAncestors(pay[1]!, clientIp(request.headers)) : "'self'"
    const response = proceed(request, ancestors)
    response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin")
    return response
  }

  if (PUBLIC_ROUTES.includes(pathname) || PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) {
    return NOT_PAGES.test(pathname) ? NextResponse.next() : proceed(request)
  }

  if (isAuthRoute) {
    if (signedIn) return NextResponse.redirect(new URL(HOME, request.url))
    if (pathname === "/sign-in/two-factor" && !request.cookies.has(CHALLENGE_COOKIE)) {
      return NextResponse.redirect(new URL("/sign-in", request.url))
    }
    return proceed(request)
  }

  if (!signedIn) {
    const url = new URL("/sign-in", request.url)
    const next = safeNext(`${pathname}${search}`)
    if (next && pathname !== HOME) url.searchParams.set("next", next)
    return NextResponse.redirect(url)
  }
  return proceed(request)
}

export const config = {
  // Everything except Next internals, static files, the file proxy (it answers 401 itself)
  // and the sign-out handler.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/|auth/sign-out|.*\\.(?:svg|png|jpg|jpeg|webp|ico)$).*)"],
}
