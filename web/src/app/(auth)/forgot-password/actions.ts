"use server"

import { redirect } from "next/navigation"
import { runAction } from "@/lib/action"
import type { ActionResult } from "@/lib/action-result"
import { api } from "@/lib/api/client"
import { setAuthEmail } from "@/lib/auth-email"
import { emailOnlySchema } from "@/lib/schemas"

/** The backend answers the same whether or not the email has an account, so this always moves on to the code. */
export async function requestPasswordReset(input: unknown): Promise<ActionResult> {
  const body = emailOnlySchema.parse(input)
  const result = await runAction(() => api("/api/auth/password/reset", { method: "POST", json: body, auth: false }))
  if (!result.ok) return result
  await setAuthEmail(body.email)
  redirect("/reset-password")
}
