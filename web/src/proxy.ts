import { NextResponse, type NextRequest } from "next/server"

// Auth-state guard only. Business-status routing happens on the server with GET /api/business,
// because the proxy can't verify the JWT or see the business.
const SESSION_COOKIE = "lp_session"
const CHALLENGE_COOKIE = "lp_2fa"

const AUTH_ROUTES = ["/sign-in", "/sign-up", "/verify-email"]
// Open to everyone, signed in or not. Invite links work either way: the page decides what to show.
// /i/ is a customer's invoice (page, PDF and logo) and /pay/ a payment link: payers never have an account.
// /embed.js is the script businesses put on their own websites.
const PUBLIC_ROUTES = ["/", "/embed.js"]
const PUBLIC_PREFIXES = ["/invite/", "/i/", "/pay/"]
const HOME = "/dashboard"

const API_URL = process.env.API_URL ?? "http://localhost:4000"
const PAY_PAGE = /^\/pay\/([a-z0-9-]{6,40})\/?$/

// A link's allowed websites, briefly remembered so a page and its follow-up requests don't each ask.
const framers = new Map<string, { at: number; value: string }>()
const FRAMERS_TTL_MS = 30_000

/**
 * Who may show a payment-link page in a frame: the link's allowed websites, or any site when it has none
 * (docs/briefs/payment-links.md §5). Unknown links get 'self' only; the page itself says "not found".
 */
async function frameAncestors(slug: string, clientIp: string | null) {
  const hit = framers.get(slug)
  if (hit && Date.now() - hit.at < FRAMERS_TTL_MS) return hit.value
  let value = "'self'"
  try {
    const res = await fetch(`${API_URL}/api/public/pay/${slug}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(3000),
      // The payer's address, so the backend's rate limit counts them and not this server.
      headers: clientIp ? { "X-Forwarded-For": clientIp } : undefined,
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

  const pay = PAY_PAGE.exec(pathname)
  if (pay) {
    const response = NextResponse.next()
    response.headers.set("Content-Security-Policy", `frame-ancestors ${await frameAncestors(pay[1]!, request.headers.get("x-forwarded-for"))}`)
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
    if (pathname !== HOME) url.searchParams.set("next", `${pathname}${search}`)
    return NextResponse.redirect(url)
  }
  return NextResponse.next()
}

export const config = {
  // Everything except Next internals, static files, the file proxy (it answers 401 itself)
  // and the sign-out handler.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/|auth/sign-out|.*\\.(?:svg|png|jpg|jpeg|webp|ico)$).*)"],
}
