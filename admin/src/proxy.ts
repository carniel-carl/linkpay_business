import { NextResponse, type NextRequest } from "next/server"
import { CSP_REPORT_GROUP, CSP_REPORT_PATH, REPORTING_ENDPOINTS } from "@/lib/csp-report"
import { safeNext } from "@/lib/safe-next"

// Auth-state guard only: the proxy can't verify the staff token. The console layout does that
// with GET /api/admin/auth/me and signs out an ended session. Names match lib/session.ts.
const SESSION_COOKIE = "lp_staff_session"
const CHALLENGE_COOKIE = "lp_staff_2fa"

const AUTH_ROUTES = ["/sign-in"]
// Open signed in or out; the invite page explains what to do when someone is already signed in.
const PUBLIC_ROUTES = ["/invite"]
const HOME = "/"

const DEV = process.env.NODE_ENV === "development"
// CSP_REPORT_ONLY=1 reports what the policy would block instead of blocking it, to roll it out safely; next.config.ts
// keeps frame-ancestors 'none' enforced meanwhile.
const REPORT_ONLY = process.env.CSP_REPORT_ONLY === "1"

/**
 * The Content-Security-Policy for a page. Scripts run only with this request's nonce, and what they load from
 * there ('strict-dynamic'); 'self' is for browsers older than CSP 3. Everything is loaded from this server, and the
 * browser talks only to it (the API is server-side).
 */
function contentSecurityPolicy(nonce: string, https: boolean) {
  return [
    "default-src 'self'",
    // React uses eval for its debugging information in development only.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${DEV ? " 'unsafe-eval'" : ""}`,
    // React renders style attributes, and Sonner and Radix (its scroll lock) add <style> elements with no nonce.
    "style-src 'self' 'unsafe-inline'",
    // The authenticator QR code is a data: URL; KYB images come through /api/files.
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    // KYB PDFs are previewed in a frame from /api/files (components/admin/document-viewer.tsx).
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
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
 * there for its own scripts, and the root layout reads x-nonce for next-themes.
 */
function proceed(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64")
  const policy = contentSecurityPolicy(nonce, request.nextUrl.protocol === "https:")
  const headers = new Headers(request.headers)
  headers.set("x-nonce", nonce)
  headers.set("Content-Security-Policy", policy)
  const response = NextResponse.next({ request: { headers } })
  response.headers.set(REPORT_ONLY ? "Content-Security-Policy-Report-Only" : "Content-Security-Policy", policy)
  response.headers.set("Reporting-Endpoints", REPORTING_ENDPOINTS)
  return response
}

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl
  const signedIn = request.cookies.has(SESSION_COOKIE)
  const matches = (r: string) => pathname === r || pathname.startsWith(`${r}/`)
  if (PUBLIC_ROUTES.some(matches)) return proceed(request)
  const isAuthRoute = AUTH_ROUTES.some(matches)

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
