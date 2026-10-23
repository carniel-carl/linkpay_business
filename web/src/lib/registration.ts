import "server-only"
import { cookies } from "next/headers"

// The registration token from sign-up, kept for verify-email. Verifying with it is what keeps the password
// chosen at sign-up (backend/src/services/passwords.ts). It's only read from this httpOnly cookie, never from
// the URL, so nobody can send a link that verifies with their own sign-up's token.
const REGISTRATION_COOKIE = "lp_registration"

const secure = process.env.NODE_ENV === "production"

export async function setRegistration(email: string, token: string) {
  ;(await cookies()).set(REGISTRATION_COOKIE, JSON.stringify({ email, token }), {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    // The backend accepts the token for a day.
    maxAge: 60 * 60 * 24,
  })
}

async function getRegistration() {
  const raw = (await cookies()).get(REGISTRATION_COOKIE)?.value
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as { email?: string; token?: string }
  } catch {
    return undefined
  }
}

/** The token, if this browser signed up with `email`. */
export async function getRegistrationToken(email: string) {
  const saved = await getRegistration()
  return saved?.email === email ? saved.token : undefined
}

/** The email this browser signed up with, while its token lasts. */
export async function getRegistrationEmail() {
  return (await getRegistration())?.email || undefined
}

export async function clearRegistration() {
  ;(await cookies()).delete(REGISTRATION_COOKIE)
}
