import { NextResponse, type NextRequest } from "next/server"
import { api } from "@/lib/api/client"
import { ApiError } from "@/lib/api/errors"
import { safeNext } from "@/lib/safe-next"
import { CHALLENGE_COOKIE, CHOICE_COOKIES, SESSION_COOKIE } from "@/lib/session"

const HOME = "/dashboard"

// A relative Location. Behind a proxy, `next start` builds request.url from the address it listens on
// (http://localhost:3000), not the one the browser used, so an absolute redirect would leave the site.
const redirectTo = (location: string) => new NextResponse(null, { status: 307, headers: { Location: location } })

/** Whether the API refuses the session token now: expired, signed out elsewhere, or its account is gone (lib/data.ts). */
async function sessionRefused() {
  try {
    await api("/api/auth/me")
    return false
  } catch (err) {
    // Unreachable or failing: it can't say, so the session is left alone.
    return err instanceof ApiError && (err.sessionExpired || (err.authed && err.status === 404))
  }
}

/**
 * Ends the session and clears its cookies. Server Components redirect here when the token has expired, and an
 * invite link sends people here to switch accounts (with a stale session). `next` carries through to sign-in.
 *
 * It's a GET, so another website could link here and sign people out (the Lax cookie goes with a link). Only this
 * site's own pages and an address typed or bookmarked (Sec-Fetch-Site same-origin or none) end a session. Anything
 * else, browsers that don't send Sec-Fetch-Site included, only clears a session the API already refuses: what the
 * expired redirects are for, and they can follow a link from an email, which makes them cross-site too. A session
 * that still works is left as it is, and the visitor goes on to `next` or the dashboard.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams
  const query = new URLSearchParams()
  if (params.get("expired")) query.set("expired", "1")
  const next = safeNext(params.get("next"))
  if (next) query.set("next", next)
  const search = query.toString()
  const signIn = search ? `/sign-in?${search}` : "/sign-in"

  const site = request.headers.get("sec-fetch-site")
  const direct = site === "same-origin" || site === "none"
  const signedIn = request.cookies.has(SESSION_COOKIE)
  if (!direct) {
    // Nothing to end; sign-in takes it from there.
    if (!signedIn) return redirectTo(signIn)
    if (!(await sessionRefused())) return redirectTo(next ?? HOME)
  }

  // A token the API already refuses is ignored there.
  if (direct && signedIn) await api("/api/auth/logout", { method: "POST" }).catch(() => {})

  const res = redirectTo(signIn)
  res.cookies.delete(SESSION_COOKIE)
  res.cookies.delete(CHALLENGE_COOKIE)
  for (const name of CHOICE_COOKIES) res.cookies.delete(name)
  return res
}
