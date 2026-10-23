"use server"

import { redirect } from "next/navigation"
import { runAction } from "@/lib/action"
import { api } from "@/lib/api/client"
import { ApiError, friendlyMessage } from "@/lib/api/errors"
import type { AuthSession, TwoFactorChallenge } from "@/lib/api/types"
import { clearAuthEmail, setAuthEmail } from "@/lib/auth-email"
import type { ActionResult } from "@/lib/action-result"
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

export async function verifyTwoFactor(input: { code: string }, next?: string): Promise<ActionResult> {
  const challenge = await getChallenge()
  if (!challenge) return { ok: false, error: "Your sign-in has expired. Start again.", code: "INVALID_TOKEN" }
  const result = await runAction(() =>
    api<AuthSession>("/api/auth/login/2fa", {
      method: "POST",
      json: { challengeToken: challenge.token, code: code.parse(input.code) },
      auth: false,
    }),
  )
  if (!result.ok) {
    if (challenge.method === "totp" && result.code === "INVALID_CODE") {
      return { ...result, error: "That code didn't work. Enter the current code from your authenticator app." }
    }
    return result
  }
  await setSession(result.data.accessToken)
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
