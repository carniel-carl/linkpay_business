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
    const response = NextResponse.next()
    response.headers.set("Content-Security-Policy", `frame-ancestors ${ancestors}`)
    response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin")
    return response
  }

  if (PUBLIC_ROUTES.includes(pathname) || PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) {
    return NextResponse.next()
  }

  if (isAuthRoute) {
    if (signedIn) return NextResponse.redirect(new URL(HOME, request.url))
    if (pathname === "/sign-in/two-factor" && !request.cookies.has(CHALLENGE_COOKIE)) {
      return NextResponse.redirect(new URL("/sign-in", request.url))
    }
    return NextResponse.next()
  }

  if (!signedIn) {
    const url = new URL("/sign-in", request.url)
    const next = safeNext(`${pathname}${search}`)
    if (next && pathname !== HOME) url.searchParams.set("next", next)
    return NextResponse.redirect(url)
  }
  return NextResponse.next()
}

export const config = {
  // Everything except Next internals, static files, the file proxy (it answers 401 itself)
  // and the sign-out handler.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/|auth/sign-out|.*\\.(?:svg|png|jpg|jpeg|webp|ico)$).*)"],
}
