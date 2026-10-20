import { NextResponse, type NextRequest } from "next/server"

// Auth-state guard only. Business-status routing happens on the server with GET /api/business,
// because the proxy can't verify the JWT or see the business.
const SESSION_COOKIE = "lp_session"
const CHALLENGE_COOKIE = "lp_2fa"

const AUTH_ROUTES = ["/sign-in", "/sign-up", "/verify-email"]
// Open to everyone, signed in or not. Invite links work either way: the page decides what to show.
const PUBLIC_ROUTES = ["/"]
const PUBLIC_PREFIXES = ["/invite/"]
const HOME = "/dashboard"

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl
  const signedIn = request.cookies.has(SESSION_COOKIE)
  const isAuthRoute = AUTH_ROUTES.some((r) => pathname === r || pathname.startsWith(`${r}/`))

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
