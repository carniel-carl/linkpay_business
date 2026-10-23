import { NextResponse, type NextRequest } from "next/server"
import { safeNext } from "@/lib/safe-next"
import { CHALLENGE_COOKIE, SESSION_COOKIE } from "@/lib/session"

/**
 * Clears the session cookies. Server Components redirect here when the staff session has ended
 * (the backend already refuses the token, so there's nothing to revoke). `next` carries through to sign-in.
 */
export function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams
  const url = new URL("/sign-in", request.url)
  if (params.get("expired")) url.searchParams.set("expired", "1")
  const reason = params.get("reason")
  if (reason === "disabled" || reason === "no_role") url.searchParams.set("reason", reason)
  const next = safeNext(params.get("next"))
  if (next) url.searchParams.set("next", next)

  const res = NextResponse.redirect(url)
  res.cookies.delete(SESSION_COOKIE)
  res.cookies.delete(CHALLENGE_COOKIE)
  return res
}
