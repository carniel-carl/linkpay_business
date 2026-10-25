"use server"

import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { z } from "zod"
import { runAction } from "@/lib/action"
import { api } from "@/lib/api/client"
import { ApiError, friendlyMessage } from "@/lib/api/errors"
import type { AuthSession, TwoFactorChallenge, TwoFactorSession } from "@/lib/api/types"
import { clearAuthEmail, setAuthEmail } from "@/lib/auth-email"
import type { ActionResult } from "@/lib/action-result"
import { RECOVERY_NOTICE_COOKIE, RECOVERY_NOTICE_MAX_AGE } from "@/lib/recovery-codes"
import { safeNext } from "@/lib/safe-next"
import { clearSession, getChallenge, getSessionToken, setChallenge, setSession } from "@/lib/session"
import { code, email, emailOnlySchema, signInSchema } from "@/lib/schemas"

type LoginResponse = AuthSession | TwoFactorChallenge

async function finishLogin(res: LoginResponse, userEmail: string, next?: string): Promise<never> {
  // Only a path on this site goes on as the post-login destination.
  const target = safeNext(next)
  await clearAuthEmail()
  if ("twoFactorRequired" in res) {
    await setChallenge({ token: res.challengeToken, method: res.method, email: userEmail })
    redirect(`/sign-in/two-factor${target ? `?next=${encodeURIComponent(target)}` : ""}`)
  }
  await setSession(res.accessToken)
  redirect(target ?? "/dashboard")
}

export async function resendVerification(input: { email: string }): Promise<ActionResult> {
  const body = emailOnlySchema.parse(input)
  return runAction(() => api("/api/auth/verify-email/resend", { method: "POST", json: body, auth: false }))
}

export async function signIn(input: unknown, next?: string): Promise<ActionResult> {
  const body = signInSchema.parse(input)
  try {
    const res = await api<LoginResponse>("/api/auth/login", { method: "POST", json: body, auth: false })
    return await finishLogin(res, body.email, next)
  } catch (err) {
    if (err instanceof ApiError) {
      // The backend has already emailed a fresh code, so go straight to verification.
      if (err.code === "EMAIL_NOT_VERIFIED") {
        await setAuthEmail(body.email)
        redirect("/verify-email")
      }
      return { ok: false, error: friendlyMessage(err), code: err.code }
    }
    throw err
  }
}

export async function requestLoginCode(input: { email: string }): Promise<ActionResult> {
  const body = emailOnlySchema.parse(input)
  return runAction(() => api("/api/auth/otp/request", { method: "POST", json: body, auth: false }))
}

export async function verifyLoginCode(input: { email: string; code: string }, next?: string): Promise<ActionResult> {
  const body = { email: email.parse(input.email), code: code.parse(input.code) }
  const result = await runAction(() =>
    api<LoginResponse>("/api/auth/otp/verify", { method: "POST", json: body, auth: false }),
  )
  if (!result.ok) return result
  return finishLogin(result.data, body.email, next)
}

/** The backend ignores spaces, dashes and case, so only the length is checked here. */
const recoveryCode = z.string().trim().min(1, "Enter a recovery code.").max(64, "Enter just one recovery code, like abcde-fghjk.")

/** The code from the authenticator app or the email, or (authenticator app only) one of the saved recovery codes. */
export async function verifyTwoFactor(
  input: { code: string } | { recoveryCode: string },
  next?: string,
): Promise<ActionResult> {
  const challenge = await getChallenge()
  if (!challenge) return { ok: false, error: "Your sign-in has expired. Start again.", code: "INVALID_TOKEN" }
  let proof: { code: string } | { recoveryCode: string }
  if ("recoveryCode" in input) {
    // Typed or pasted text: several codes at once, or the whole saved file, gets a message instead of a failed page.
    const typed = recoveryCode.safeParse(input.recoveryCode)
    if (!typed.success) return { ok: false, error: typed.error.issues[0].message }
    proof = { recoveryCode: typed.data }
  } else {
    proof = { code: code.parse(input.code) }
  }
  const usingRecovery = "recoveryCode" in proof
  const result = await runAction(() =>
    api<TwoFactorSession>("/api/auth/login/2fa", {
      method: "POST",
      json: { challengeToken: challenge.token, ...proof },
      auth: false,
    }),
  )
  if (!result.ok) {
    if (usingRecovery && result.code === "INVALID_CODE") {
      return { ...result, error: "That recovery code didn't work. Check it, or try another you haven't used yet." }
    }
    if (challenge.method === "totp" && result.code === "INVALID_CODE") {
      return { ...result, error: "That code didn't work. Enter the current code from your authenticator app." }
    }
    return result
  }
  await setSession(result.data.accessToken)
  // The dashboard reads this once and says how many codes are left (see RecoveryCodeNotice).
  const jar = await cookies()
  if (result.data.recoveryCodeUsed) {
    jar.set(RECOVERY_NOTICE_COOKIE, String(result.data.recoveryCodesLeft ?? 0), {
      httpOnly: false,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: RECOVERY_NOTICE_MAX_AGE,
    })
  } else {
    jar.delete(RECOVERY_NOTICE_COOKIE)
  }
  redirect(safeNext(next, "/dashboard"))
}

export async function resendTwoFactor(): Promise<ActionResult> {
  const challenge = await getChallenge()
  if (!challenge) return { ok: false, error: "Your sign-in has expired. Start again.", code: "INVALID_TOKEN" }
  return runAction(() =>
    api("/api/auth/login/2fa/resend", { method: "POST", json: { challengeToken: challenge.token }, auth: false }),
  )
}

export async function signOut() {
  // Ends the session on the server too, so the token stops working even if it was copied.
  if (await getSessionToken()) await api("/api/auth/logout", { method: "POST" }).catch(() => {})
  await clearSession()
  redirect("/sign-in")
}
