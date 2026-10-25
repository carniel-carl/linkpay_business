"use server"

import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { z } from "zod"
import { runAction } from "@/lib/action"
import { api } from "@/lib/api/client"
import type { StaffChallenge, StaffSession } from "@/lib/api/types"
import type { ActionResult } from "@/lib/action-result"
import { RECOVERY_NOTICE_COOKIE, RECOVERY_NOTICE_MAX_AGE } from "@/lib/recovery-codes"
import { safeNext } from "@/lib/safe-next"
import { clearSession, getChallenge, getSessionToken, setChallenge, setSession } from "@/lib/session"
import { code, signInSchema } from "@/lib/schemas"

const expiredChallenge = { ok: false as const, error: "Your sign-in has expired. Start again.", code: "INVALID_STAFF_TOKEN" }

/** Step one: the password. Two-step is mandatory for staff, so this always leads to the code step. */
export async function signIn(input: unknown, next?: string): Promise<ActionResult> {
  const body = signInSchema.parse(input)
  const result = await runAction(() =>
    api<StaffChallenge>("/api/admin/auth/login", { method: "POST", json: body, auth: false }),
  )
  if (!result.ok) return result
  await setChallenge({ token: result.data.challengeToken, method: result.data.method, email: body.email })
  // Only a path on this site goes on as the post-login destination.
  const target = safeNext(next)
  redirect(`/sign-in/two-factor${target ? `?next=${encodeURIComponent(target)}` : ""}`)
}

/** The backend ignores spaces, dashes and case, so only the length is checked here. */
const recoveryCode = z.string().trim().min(1, "Enter a recovery code.").max(64, "Enter just one recovery code, like abcde-fghjk.")

/** The code from the authenticator app or the email, or (authenticator app only) one of the saved recovery codes. */
export async function verifyTwoFactor(
  input: { code: string } | { recoveryCode: string },
  next?: string,
): Promise<ActionResult> {
  const challenge = await getChallenge()
  if (!challenge) return expiredChallenge
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
    api<StaffSession>("/api/admin/auth/login/2fa", {
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
  // The console reads this once and says how many codes are left (see RecoveryCodeNotice).
  const jar = await cookies()
  if (result.data.recoveryCodeUsed) {
    jar.set(RECOVERY_NOTICE_COOKIE, String(result.data.recoveryCodesLeft ?? 0), {
      httpOnly: false,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
      maxAge: RECOVERY_NOTICE_MAX_AGE,
    })
  } else {
    jar.delete(RECOVERY_NOTICE_COOKIE)
  }
  redirect(safeNext(next, "/"))
}

export async function resendTwoFactor(): Promise<ActionResult> {
  const challenge = await getChallenge()
  if (!challenge) return expiredChallenge
  return runAction(() =>
    api("/api/admin/auth/login/2fa/resend", { method: "POST", json: { challengeToken: challenge.token }, auth: false }),
  )
}

export async function signOut() {
  // Ends the session on the server too, so the token stops working even if it was copied.
  if (await getSessionToken()) await api("/api/admin/auth/logout", { method: "POST" }).catch(() => {})
  await clearSession()
  redirect("/sign-in")
}
