"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { runAction } from "@/lib/action"
import { api } from "@/lib/api/client"
import type { RecoveryCodes, User } from "@/lib/api/types"
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

/** Needs the password, so a stolen session alone can't add or swap the authenticator. */
export async function startTotpSetup(input: unknown) {
  const body = passwordConfirmSchema.parse(input)
  return runAction(() =>
    api<{ secret: string; otpauthUrl: string }>("/api/auth/2fa/totp/setup", { method: "POST", json: body }),
  )
}

/** Also returns the 10 recovery codes, shown once. */
export async function enableTotp(input: { code: string }) {
  const body = { code: code.parse(input.code) }
  return done(
    await runAction(() => api<{ user: User } & RecoveryCodes>("/api/auth/2fa/totp/enable", { method: "POST", json: body })),
  )
}

/** New recovery codes replace the old ones. Needs the password or a current authenticator code, as setup does. */
export async function newRecoveryCodes(input: unknown) {
  const body = z.union([passwordConfirmSchema, z.object({ code })]).parse(input)
  return done(await runAction(() => api<RecoveryCodes>("/api/auth/2fa/recovery-codes", { method: "POST", json: body })))
}

export async function enableEmailTwoFactor(input: unknown) {
  const body = passwordConfirmSchema.parse(input)
  return done(await runAction(() => api<{ user: User }>("/api/auth/2fa/email/enable", { method: "POST", json: body })))
}

export async function disableTwoFactor(input: unknown) {
  const body = passwordConfirmSchema.parse(input)
  return done(await runAction(() => api<{ user: User }>("/api/auth/2fa/disable", { method: "POST", json: body })))
}

export async function signOutSession(id: string) {
  const sessionId = z.string().regex(/^[a-f\d]{24}$/i).parse(id)
  return done(await runAction(() => api<void>(`/api/auth/sessions/${sessionId}`, { method: "DELETE" })))
}

/** Every other browser and phone; this one stays signed in. */
export async function signOutOtherSessions() {
  return done(await runAction(() => api<{ revoked: number }>("/api/auth/sessions/revoke-others", { method: "POST" })))
}
