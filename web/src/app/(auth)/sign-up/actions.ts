"use server"

import { redirect } from "next/navigation"
import { runAction } from "@/lib/action"
import type { ActionResult } from "@/lib/action-result"
import { api } from "@/lib/api/client"
import { setAuthEmail } from "@/lib/auth-email"
import { setRegistration } from "@/lib/registration"
import { signUpSchema } from "@/lib/schemas"

/**
 * The backend answers the same whether or not the email has an account (an unverified one is replaced), so
 * every sign-up goes on to verify-email. The email and its registration token wait in cookies for that step.
 */
export async function signUp(input: unknown): Promise<ActionResult> {
  const body = signUpSchema.parse(input)
  const result = await runAction(() =>
    api<{ registrationToken: string }>("/api/auth/register", { method: "POST", json: body, auth: false }),
  )
  if (!result.ok) return result
  await setRegistration(body.email, result.data.registrationToken)
  await setAuthEmail(body.email)
  redirect("/verify-email")
}
