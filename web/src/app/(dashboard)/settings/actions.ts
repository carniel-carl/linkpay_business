"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { runAction } from "@/lib/action"
import { api } from "@/lib/api/client"
import type { User } from "@/lib/api/types"
import { getMe } from "@/lib/data"
import { code, passwordConfirmSchema } from "@/lib/schemas"

async function done<T>(result: Awaited<ReturnType<typeof runAction<T>>>) {
  if (result.ok) revalidatePath("/", "layout")
  return result
}

export async function updateName(input: unknown) {
  const body = z.object({ name: z.string().trim().min(1) }).parse(input)
  const me = await getMe()
  return done(await runAction(() => api<User>(`/api/users/${me._id}`, { method: "PATCH", json: body })))
}

export async function startTotpSetup() {
  return runAction(() => api<{ secret: string; otpauthUrl: string }>("/api/auth/2fa/totp/setup", { method: "POST" }))
}

export async function enableTotp(input: { code: string }) {
  const body = { code: code.parse(input.code) }
  return done(await runAction(() => api<{ user: User }>("/api/auth/2fa/totp/enable", { method: "POST", json: body })))
}

export async function enableEmailTwoFactor(input: unknown) {
  const body = passwordConfirmSchema.parse(input)
  return done(await runAction(() => api<{ user: User }>("/api/auth/2fa/email/enable", { method: "POST", json: body })))
}

export async function disableTwoFactor(input: unknown) {
  const body = passwordConfirmSchema.parse(input)
  return done(await runAction(() => api<{ user: User }>("/api/auth/2fa/disable", { method: "POST", json: body })))
}
