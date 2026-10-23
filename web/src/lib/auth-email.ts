import "server-only"
import { cookies } from "next/headers"
import { email } from "@/lib/schemas"

// The email that sign-up, verify-email, password reset and the sign-in after it are about. It goes from one page
// to the next in this httpOnly cookie, not in the URL, where it would end up in browser history, server and proxy
// logs and Referer headers. Pages read it on the server and ask for the email again when it's missing.
const AUTH_EMAIL_COOKIE = "lp_auth_email"

const secure = process.env.NODE_ENV === "production"

export async function setAuthEmail(address: string) {
  ;(await cookies()).set(AUTH_EMAIL_COOKIE, address, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    // Time to wait for a code and ask for another. Reloading after that starts the step again.
    maxAge: 60 * 60,
  })
}

export async function getAuthEmail() {
  const parsed = email.safeParse((await cookies()).get(AUTH_EMAIL_COOKIE)?.value)
  return parsed.success ? parsed.data : undefined
}

/** The flow is over: the email is verified, or the person has signed in. */
export async function clearAuthEmail() {
  ;(await cookies()).delete(AUTH_EMAIL_COOKIE)
}
