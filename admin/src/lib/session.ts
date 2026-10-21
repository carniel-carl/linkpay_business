import "server-only"
import { cookies } from "next/headers"
import type { TwoFactorMethod } from "@/lib/api/types"

// Different names from the business web's cookies, so the two apps never read each other's session.
export const SESSION_COOKIE = "lp_staff_session"
export const CHALLENGE_COOKIE = "lp_staff_2fa"

const secure = process.env.NODE_ENV === "production"

/** Reads `exp` from the JWT so the cookie lives exactly as long as the token. */
function tokenMaxAge(token: string, fallback: number) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"))
    const seconds = Math.floor(payload.exp - Date.now() / 1000)
    return seconds > 0 ? seconds : fallback
  } catch {
    return fallback
  }
}

export async function getSessionToken() {
  return (await cookies()).get(SESSION_COOKIE)?.value ?? null
}

export async function setSession(accessToken: string) {
  const jar = await cookies()
  jar.set(SESSION_COOKIE, accessToken, {
    httpOnly: true,
    secure,
    sameSite: "strict",
    path: "/",
    maxAge: tokenMaxAge(accessToken, 60 * 60 * 12),
  })
  jar.delete(CHALLENGE_COOKIE)
}

export async function clearSession() {
  const jar = await cookies()
  jar.delete(SESSION_COOKIE)
  jar.delete(CHALLENGE_COOKIE)
}

export type Challenge = { token: string; method: TwoFactorMethod; email: string }

/** Holds the short-lived 2FA challenge token between the password and code steps. */
export async function setChallenge(challenge: Challenge) {
  ;(await cookies()).set(CHALLENGE_COOKIE, JSON.stringify(challenge), {
    httpOnly: true,
    secure,
    sameSite: "strict",
    path: "/",
    maxAge: tokenMaxAge(challenge.token, 600),
  })
}

export async function getChallenge(): Promise<Challenge | null> {
  const raw = (await cookies()).get(CHALLENGE_COOKIE)?.value
  if (!raw) return null
  try {
    return JSON.parse(raw) as Challenge
  } catch {
    return null
  }
}
