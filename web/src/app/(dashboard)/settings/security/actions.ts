"use server"

import { redirect } from "next/navigation"
import { runAction } from "@/lib/action"
import type { ActionResult } from "@/lib/action-result"
import { api } from "@/lib/api/client"
import { getMe } from "@/lib/data"
import { changePasswordSchema } from "@/lib/schemas"

/** Signs out every other device. This browser stays signed in. */
export async function changePassword(input: unknown): Promise<ActionResult> {
  const body = changePasswordSchema.parse(input)
  return runAction(() => api("/api/auth/password", { method: "POST", json: body }))
}

/** An account with no password sets one through a reset: a code to its email, then the reset page. */
export async function startSettingPassword(): Promise<ActionResult> {
  const me = await getMe()
  const result = await runAction(() =>
    api("/api/auth/password/reset", { method: "POST", json: { email: me.email }, auth: false }),
  )
  if (!result.ok) return result
  redirect(`/reset-password?email=${encodeURIComponent(me.email)}`)
}
