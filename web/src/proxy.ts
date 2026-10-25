import { NextResponse, type NextRequest } from "next/server"
import { clientIp, forwardIpHeaders } from "@/lib/client-ip"
import { CSP_REPORT_GROUP, CSP_REPORT_PATH, REPORTING_ENDPOINTS } from "@/lib/csp-report"
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
    // Violations go to app/api/csp-report: report-to where the Reporting API is (Reporting-Endpoints below names
    // the group), report-uri elsewhere. Browsers with both use report-to.
    `report-uri ${CSP_REPORT_PATH}`,
    `report-to ${CSP_REPORT_GROUP}`,
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
  response.headers.set("Reporting-Endpoints", REPORTING_ENDPOINTS)
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

// A link's allowed websites as the API last gave them, so a page and its follow-up requests don't each ask: asked
// again after 30 seconds. Only the API's answers are kept, never a failure to get one.
const framers = new Map<string, { at: number; value: string }>()
const FRAMERS_TTL_MS = 30_000
const MAX_FRAMERS = 1000

/**
 * The link's frame-ancestors as the API gives them now (`keep`: worth remembering), or null when it couldn't say:
 * a timeout, a 5xx, or a 429. It's asked as this server, not the visitor, so the answer doesn't depend on the
 * visitor's own rate limit. If this server's limit is spent (someone asking about made-up links, say), it's asked
 * again as the visitor, so that can't stop every embed working; whatever that visitor's limit makes of it is
 * theirs alone, since a failure is never remembered.
 */
async function lookUpFramers(slug: string, visitorIp: string | undefined) {
  const signal = AbortSignal.timeout(3000)
  const url = `${API_URL}/api/public/pay/${slug}`
  const ask = (ip?: string) => fetch(url, { cache: "no-store", signal, headers: forwardIpHeaders(ip, url) })
  try {
    let res = await ask()
    if (res.status === 429 && visitorIp) res = await ask(visitorIp)
    // No such link: the page says "not found", and nothing is remembered.
    if (res.status === 404) return { value: "'self'", keep: false }
    if (!res.ok) return null
    const body = (await res.json()) as { embed?: { allowedOrigins?: string[] } }
    const allowed = (body.embed?.allowedOrigins ?? []).filter((o) => /^https?:\/\/[a-z0-9.*:[\]-]+$/i.test(o))
    return { value: allowed.length ? ["'self'", ...allowed].join(" ") : "*", keep: true }
  } catch {
    return null
  }
}

/**
 * Who may show a payment-link page in a frame: the link's allowed websites, or any site when it has none
 * (docs/briefs/payment-links.md §5). Unknown links get 'self' only; the page itself says "not found". When the
 * API can't be asked, the last answer it gave stands (a merchant's embed keeps working through a blip), and with
 * none, 'self' for this request only: no other sites frame it meanwhile, and the next request asks again.
 */
async function frameAncestors(slug: string, visitorIp: string | undefined) {
  const hit = framers.get(slug)
  if (hit && Date.now() - hit.at < FRAMERS_TTL_MS) return hit.value
  const answer = await lookUpFramers(slug, visitorIp)
  if (!answer) return hit?.value ?? "'self'"
  // Re-added, so the oldest answers are the ones let go.
  framers.delete(slug)
  if (answer.keep) {
    framers.set(slug, { at: Date.now(), value: answer.value })
    if (framers.size > MAX_FRAMERS) framers.delete(framers.keys().next().value!)
  }
  return answer.value
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
  // Everything except Next internals, the icons in src/app (the only static files at the root), the file proxy (it
  // answers 401 itself) and the sign-out handler. Named files only: a page whose address ends in ".png" is still a
  // page, and gets its policy.
  matcher: ["/((?!_next/static|_next/image|api/|auth/sign-out|(?:favicon\\.ico|icon\\.svg|apple-icon\\.png)$).*)"],
}
