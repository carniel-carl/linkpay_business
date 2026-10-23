"use server"

import { runAction } from "@/lib/action"
import type { ActionResult } from "@/lib/action-result"
import { api } from "@/lib/api/client"
import { setAuthEmail } from "@/lib/auth-email"
import { email, emailOnlySchema, resetPasswordSchema } from "@/lib/schemas"
import { clearSession } from "@/lib/session"

export async function resendResetCode(input: { email: string }): Promise<ActionResult> {
  const body = emailOnlySchema.parse(input)
  return runAction(() => api("/api/auth/password/reset", { method: "POST", json: body, auth: false }))
}

/**
 * Sets the new password. The backend ends every session, so this browser's cookie goes too (an account with
 * no password may have come here signed in). Nobody is signed in afterwards: two-step verification still
 * applies when they sign in with the new password. The email cookie is renewed for the sign-in that follows
 * (and so this page, drawn again because cookies changed, still has it).
 */
export async function resetPassword(address: string, input: unknown): Promise<ActionResult> {
  const body = { email: email.parse(address), ...resetPasswordSchema.parse(input) }
  const result = await runAction(() =>
    api<void>("/api/auth/password/reset/confirm", { method: "POST", json: body, auth: false }),
  )
  if (result.ok) {
    await clearSession()
    await setAuthEmail(body.email)
  }
  return result
}
