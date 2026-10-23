import { NextResponse, type NextRequest } from "next/server"
import { api } from "@/lib/api/client"
import { safeNext } from "@/lib/safe-next"
import { CHALLENGE_COOKIE, CHOICE_COOKIES, SESSION_COOKIE } from "@/lib/session"

/**
 * Ends the session and clears its cookies. Server Components redirect here when the token has expired, and an
 * invite link sends people here to switch accounts. `next` carries through to sign-in.
 */
export async function GET(request: NextRequest) {
  // A token the API already refuses is ignored there.
  if (request.cookies.has(SESSION_COOKIE)) await api("/api/auth/logout", { method: "POST" }).catch(() => {})

  const params = request.nextUrl.searchParams
  const query = new URLSearchParams()
  if (params.get("expired")) query.set("expired", "1")
  const next = safeNext(params.get("next"))
  if (next) query.set("next", next)

  // A relative Location. Behind a proxy, `next start` builds request.url from the address it listens on
  // (http://localhost:3000), not the one the browser used, so an absolute redirect would leave the site.
  const search = query.toString()
  const res = new NextResponse(null, { status: 307, headers: { Location: search ? `/sign-in?${search}` : "/sign-in" } })
  res.cookies.delete(SESSION_COOKIE)
  res.cookies.delete(CHALLENGE_COOKIE)
  for (const name of CHOICE_COOKIES) res.cookies.delete(name)
  return res
}
