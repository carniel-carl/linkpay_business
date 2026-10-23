"use server"

import { redirect } from "next/navigation"
import { runAction } from "@/lib/action"
import type { ActionResult } from "@/lib/action-result"
import { api } from "@/lib/api/client"
import type { AuthSession } from "@/lib/api/types"
import { clearRegistration, getRegistrationToken } from "@/lib/registration"
import { code, email } from "@/lib/schemas"
import { setSession } from "@/lib/session"

/**
 * Sends this browser's registration token when it signed up with this email, so the password chosen then is
 * kept. Without it (another browser, or a sign-up made by someone else) the email is still verified, but the
 * account has no password until one is set with "Forgot password?".
 */
export async function verifyEmail(input: { email: string; code: string }): Promise<ActionResult> {
  const address = email.parse(input.email)
  const body = { email: address, code: code.parse(input.code), registrationToken: await getRegistrationToken(address) }
  const result = await runAction(() =>
    api<AuthSession>("/api/auth/verify-email", { method: "POST", json: body, auth: false }),
  )
  if (!result.ok) return result
  await clearRegistration()
  await setSession(result.data.accessToken)
  redirect("/dashboard")
}
