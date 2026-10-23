import { NextResponse, type NextRequest } from "next/server"
import { safeNext } from "@/lib/safe-next"
import { CHALLENGE_COOKIE, SESSION_COOKIE } from "@/lib/session"

/**
 * Clears the session cookies. Server Components redirect here when the staff session has ended
 * (the backend already refuses the token, so there's nothing to revoke). `next` carries through to sign-in.
 */
export function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams
  const query = new URLSearchParams()
  if (params.get("expired")) query.set("expired", "1")
  const reason = params.get("reason")
  if (reason === "disabled" || reason === "no_role") query.set("reason", reason)
  const next = safeNext(params.get("next"))
  if (next) query.set("next", next)

  // A relative Location. Behind a proxy, `next start` builds request.url from the address it listens on
  // (http://localhost:3001), not the one the browser used, so an absolute redirect would leave the site.
  const search = query.toString()
  const res = new NextResponse(null, { status: 307, headers: { Location: search ? `/sign-in?${search}` : "/sign-in" } })
  res.cookies.delete(SESSION_COOKIE)
  res.cookies.delete(CHALLENGE_COOKIE)
  return res
}
