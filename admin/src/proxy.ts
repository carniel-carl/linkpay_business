import { NextResponse, type NextRequest } from "next/server"
import { safeNext } from "@/lib/safe-next"

// Auth-state guard only: the proxy can't verify the staff token. The console layout does that
// with GET /api/admin/auth/me and signs out an ended session. Names match lib/session.ts.
const SESSION_COOKIE = "lp_staff_session"
const CHALLENGE_COOKIE = "lp_staff_2fa"

const AUTH_ROUTES = ["/sign-in"]
// Open signed in or out; the invite page explains what to do when someone is already signed in.
const PUBLIC_ROUTES = ["/invite"]
const HOME = "/"

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl
  const signedIn = request.cookies.has(SESSION_COOKIE)
  const matches = (r: string) => pathname === r || pathname.startsWith(`${r}/`)
  if (PUBLIC_ROUTES.some(matches)) return NextResponse.next()
  const isAuthRoute = AUTH_ROUTES.some(matches)

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
