"use server"

import { redirect } from "next/navigation"
import { runAction } from "@/lib/action"
import { api } from "@/lib/api/client"
import type { StaffChallenge, StaffSession } from "@/lib/api/types"
import type { ActionResult } from "@/lib/action-result"
import { clearSession, getChallenge, getSessionToken, setChallenge, setSession } from "@/lib/session"
import { code, signInSchema } from "@/lib/schemas"

/** Only allow same-site relative paths as a post-login destination. */
function safeNext(next?: string) {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/"
}

const expiredChallenge = { ok: false as const, error: "Your sign-in has expired. Start again.", code: "INVALID_STAFF_TOKEN" }

/** Step one: the password. Two-step is mandatory for staff, so this always leads to the code step. */
export async function signIn(input: unknown, next?: string): Promise<ActionResult> {
  const body = signInSchema.parse(input)
  const result = await runAction(() =>
    api<StaffChallenge>("/api/admin/auth/login", { method: "POST", json: body, auth: false }),
  )
  if (!result.ok) return result
  await setChallenge({ token: result.data.challengeToken, method: result.data.method, email: body.email })
  redirect(`/sign-in/two-factor${next ? `?next=${encodeURIComponent(next)}` : ""}`)
}

export async function verifyTwoFactor(input: { code: string }, next?: string): Promise<ActionResult> {
  const challenge = await getChallenge()
  if (!challenge) return expiredChallenge
  const result = await runAction(() =>
    api<StaffSession>("/api/admin/auth/login/2fa", {
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
  redirect(safeNext(next))
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
