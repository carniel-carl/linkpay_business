import { NextResponse, type NextRequest } from "next/server"
import { api } from "@/lib/api/client"
import { ApiError } from "@/lib/api/errors"
import { safeNext } from "@/lib/safe-next"
import { CHALLENGE_COOKIE, SESSION_COOKIE } from "@/lib/session"

const HOME = "/"

// A relative Location. Behind a proxy, `next start` builds request.url from the address it listens on
// (http://localhost:3001), not the one the browser used, so an absolute redirect would leave the site.
const redirectTo = (location: string) => new NextResponse(null, { status: 307, headers: { Location: location } })

/** Whether the API refuses the staff token now: expired, ended elsewhere, or the account turned off (lib/data.ts). */
async function sessionRefused() {
  try {
    await api("/api/admin/auth/me")
    return false
  } catch (err) {
    // Unreachable or failing: it can't say, so the session is left alone.
    return err instanceof ApiError && err.sessionExpired
  }
}

/**
 * Clears the session cookies. Server Components redirect here when the staff session has ended
 * (the backend already refuses the token, so there's nothing to revoke). `next` carries through to sign-in.
 *
 * It's a GET, so another website could link here and sign staff out. Only the console's own pages and an address
 * typed or bookmarked (Sec-Fetch-Site same-origin or none) clear the cookies straight away. Anything else, browsers
 * that don't send Sec-Fetch-Site included, only clears a session the API already refuses; one that still works is
 * left as it is, and the visitor goes on to `next` or the console.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams
  const query = new URLSearchParams()
  if (params.get("expired")) query.set("expired", "1")
  const reason = params.get("reason")
  if (reason === "disabled" || reason === "no_role") query.set("reason", reason)
  const next = safeNext(params.get("next"))
  if (next) query.set("next", next)
  const search = query.toString()
  const signIn = search ? `/sign-in?${search}` : "/sign-in"

  const site = request.headers.get("sec-fetch-site")
  if (site !== "same-origin" && site !== "none") {
    // Nothing to clear (the Strict cookie isn't sent from another site); sign-in takes it from there.
    if (!request.cookies.has(SESSION_COOKIE)) return redirectTo(signIn)
    if (!(await sessionRefused())) return redirectTo(next ?? HOME)
  }

  const res = redirectTo(signIn)
  res.cookies.delete(SESSION_COOKIE)
  res.cookies.delete(CHALLENGE_COOKIE)
  return res
}
