"use server"

import { revalidatePath } from "next/cache"
import { runAction } from "@/lib/action"
import { api } from "@/lib/api/client"
import type { Staff } from "@/lib/api/types"
import { changePasswordSchema, code, passwordConfirmSchema } from "@/lib/schemas"

async function done<T>(result: Awaited<ReturnType<typeof runAction<T>>>) {
  if (result.ok) revalidatePath("/security")
  return result
}

export async function startTotpSetup() {
  return runAction(() =>
    api<{ secret: string; otpauthUrl: string }>("/api/admin/auth/2fa/totp/setup", { method: "POST" }),
  )
}

export async function enableTotp(input: { code: string }) {
  const body = { code: code.parse(input.code) }
  return done(await runAction(() => api<Staff>("/api/admin/auth/2fa/totp/enable", { method: "POST", json: body })))
}

/** Switches back to emailed codes. There's no "off": two-step is mandatory for staff. */
export async function enableEmailTwoFactor(input: unknown) {
  const body = passwordConfirmSchema.parse(input)
  return done(await runAction(() => api<Staff>("/api/admin/auth/2fa/email/enable", { method: "POST", json: body })))
}

/** Changes the password. The backend signs out every other session of this staff member. */
export async function changePassword(input: unknown) {
  const { currentPassword, newPassword } = changePasswordSchema.parse(input)
  return runAction(() =>
    api<void>("/api/admin/auth/password", { method: "POST", json: { currentPassword, newPassword } }),
  )
}
