import "server-only"
import { cookies } from "next/headers"
import type { TwoFactorMethod } from "@/lib/api/types"

export const SESSION_COOKIE = "lp_session"
export const CHALLENGE_COOKIE = "lp_2fa"
/** Per-user choices cleared on sign-out, so the next person on this browser starts fresh. */
export const CHOICE_COOKIES = ["lp_business", "lp_branch"]

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
    sameSite: "lax",
    path: "/",
    maxAge: tokenMaxAge(accessToken, 60 * 60 * 24 * 7),
  })
  jar.delete(CHALLENGE_COOKIE)
}

export async function clearSession() {
  const jar = await cookies()
  jar.delete(SESSION_COOKIE)
  jar.delete(CHALLENGE_COOKIE)
  for (const name of CHOICE_COOKIES) jar.delete(name)
}

export type Challenge = { token: string; method: TwoFactorMethod; email: string }

/** Holds the short-lived 2FA challenge token between the password and code steps. */
export async function setChallenge(challenge: Challenge) {
  ;(await cookies()).set(CHALLENGE_COOKIE, JSON.stringify(challenge), {
    httpOnly: true,
    secure,
    sameSite: "lax",
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
