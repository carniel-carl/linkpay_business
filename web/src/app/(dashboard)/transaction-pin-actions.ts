"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { runAction } from "@/lib/action"
import type { ActionResult } from "@/lib/action-result"
import { api } from "@/lib/api/client"
import type { TransactionPinStatus } from "@/lib/api/types"
import { getMe } from "@/lib/data"

// The signed-in user's transaction PIN (docs/briefs/transaction-pin.md). PINs and passwords arrive only as
// arguments and leave only in the request body; nothing here logs, stores or echoes them.

const PATH = "/api/transaction-pin"
const pin = z.string().regex(/^\d{4}$/)
const password = z.string().min(1).max(128)
const code = z.string().trim().regex(/^\d{6}$/)

/** A malformed input is answered, not thrown: a thrown parse error would be logged with what it was given. */
function parse<T>(schema: z.ZodType<T>, input: unknown): { ok: true; data: T } | { ok: false; error: string } {
  const parsed = schema.safeParse(input)
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, error: "Check the PIN and password, then try again." }
}

/** Settings, Security shows the PIN's status. */
function saved<T>(result: ActionResult<T>) {
  if (result.ok) revalidatePath("/settings/security")
  return result
}

/** Whether a PIN is set or locked, and whether the account has a password to set one with. */
export async function getTransactionPinState(): Promise<ActionResult<TransactionPinStatus & { hasPassword: boolean }>> {
  return runAction(async () => {
    const [status, me] = await Promise.all([api<TransactionPinStatus>(PATH), getMe()])
    return { ...status, hasPassword: me.hasPassword !== false }
  })
}

/** The first PIN. Needs the account password. */
export async function setTransactionPin(input: { pin: string; password: string }): Promise<ActionResult<TransactionPinStatus>> {
  const body = parse(z.object({ pin, password }), input)
  if (!body.ok) return body
  return saved(await runAction(() => api<TransactionPinStatus>(PATH, { method: "POST", json: body.data })))
}

/** A new PIN, proven with the current PIN (a wrong one counts as a try) or the password. */
export async function changeTransactionPin(
  input: { newPin: string; currentPin: string } | { newPin: string; password: string },
): Promise<ActionResult<TransactionPinStatus>> {
  const body = parse(
    z.union([z.object({ newPin: pin, currentPin: pin }).strict(), z.object({ newPin: pin, password }).strict()]),
    input,
  )
  if (!body.ok) return body
  return saved(await runAction(() => api<TransactionPinStatus>(`${PATH}/change`, { method: "POST", json: body.data })))
}

/** Emails a 6-digit code for resetting a forgotten or locked PIN. One a minute (OTP_COOLDOWN). */
export async function requestTransactionPinReset() {
  return runAction(() => api<{ message: string; sentTo: string }>(`${PATH}/reset/request`, { method: "POST" }))
}

/** A forgotten or locked PIN: the password and the emailed code. Also ends a lock. */
export async function resetTransactionPin(input: {
  password: string
  code: string
  newPin: string
}): Promise<ActionResult<TransactionPinStatus>> {
  const body = parse(z.object({ password, code, newPin: pin }), input)
  if (!body.ok) return body
  return saved(await runAction(() => api<TransactionPinStatus>(`${PATH}/reset`, { method: "POST", json: body.data })))
}
