import { NextResponse, type NextRequest } from "next/server"
import { CHALLENGE_COOKIE, CHOICE_COOKIES, SESSION_COOKIE } from "@/lib/session"

/**
 * Clears the session. Server Components redirect here when the token has expired. `next` and `email`
 * carry through to sign-in (an invite link sends people here with a stale session).
 */
export function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams
  const url = new URL("/sign-in", request.url)
  if (params.get("expired")) url.searchParams.set("expired", "1")
  const next = params.get("next")
  if (next && next.startsWith("/") && !next.startsWith("//")) url.searchParams.set("next", next)
  const email = params.get("email")
  if (email) url.searchParams.set("email", email)

  const res = NextResponse.redirect(url)
  res.cookies.delete(SESSION_COOKIE)
  res.cookies.delete(CHALLENGE_COOKIE)
  for (const name of CHOICE_COOKIES) res.cookies.delete(name)
  return res
}
