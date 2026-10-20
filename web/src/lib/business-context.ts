import "server-only"
import { cookies } from "next/headers"
import { BRANCH_COOKIE } from "@/lib/branches"

/**
 * The business the user is working in, sent to the backend as `X-Business-Id`. No cookie means the
 * backend's default: the business the user owns, otherwise the one they joined first.
 */
export const BUSINESS_COOKIE = "lp_business"

export async function getBusinessCookie() {
  return (await cookies()).get(BUSINESS_COOKIE)?.value ?? null
}

/**
 * Switches business (null goes back to the default). Always clears the branch choice too: branches
 * belong to one business. Only works in Server Actions and Route Handlers.
 */
export async function setBusinessCookie(businessId: string | null) {
  const jar = await cookies()
  jar.delete(BRANCH_COOKIE)
  if (!businessId) {
    jar.delete(BUSINESS_COOKIE)
    return
  }
  jar.set(BUSINESS_COOKIE, businessId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  })
}
