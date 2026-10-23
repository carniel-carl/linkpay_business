import { NextResponse, type NextRequest } from "next/server"
import { api } from "@/lib/api/client"
import { safeNext } from "@/lib/safe-next"
import { CHALLENGE_COOKIE, CHOICE_COOKIES, SESSION_COOKIE } from "@/lib/session"

/**
 * Ends the session and clears its cookies. Server Components redirect here when the token has expired, and an
 * invite link sends people here to switch accounts. `next` and `email` carry through to sign-in.
 */
export async function GET(request: NextRequest) {
  // A token the API already refuses is ignored there.
  if (request.cookies.has(SESSION_COOKIE)) await api("/api/auth/logout", { method: "POST" }).catch(() => {})

  const params = request.nextUrl.searchParams
  const url = new URL("/sign-in", request.url)
  if (params.get("expired")) url.searchParams.set("expired", "1")
  const next = safeNext(params.get("next"))
  if (next) url.searchParams.set("next", next)
  const email = params.get("email")
  if (email) url.searchParams.set("email", email)

  const res = NextResponse.redirect(url)
  res.cookies.delete(SESSION_COOKIE)
  res.cookies.delete(CHALLENGE_COOKIE)
  for (const name of CHOICE_COOKIES) res.cookies.delete(name)
  return res
}
