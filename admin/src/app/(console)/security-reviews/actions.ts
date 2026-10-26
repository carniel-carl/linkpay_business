"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { runAction } from "@/lib/action"
import { api } from "@/lib/api/client"
import type { SecurityRequest } from "@/lib/api/types"

// Money-out security writes (security.review). Contract: docs/briefs/money-out-security.md §4.

const id = z.string().regex(/^[0-9a-f]{24}$/i)
const note = z.string().trim().min(3).max(1000)

/** Runs a write and refreshes every page (sidebar counts, the queue and the business's tabs change). */
async function write<T>(fn: () => Promise<T>) {
  const result = await runAction(fn)
  if (result.ok) revalidatePath("/", "layout")
  return result
}

/** Approving needs the call back to the business confirmed. It still waits for the cooling-off. */
export async function approveSecurityRequest(requestId: string, input: { note: string; callbackConfirmed: boolean }) {
  const body = z.object({ note, callbackConfirmed: z.literal(true) }).parse(input)
  return write(() => api<SecurityRequest>(`/api/admin/security/requests/${id.parse(requestId)}/approve`, { method: "POST", json: body }))
}

/** The note is shown to the business as the reason. */
export async function rejectSecurityRequest(requestId: string, input: { note: string }) {
  const body = z.object({ note }).parse(input)
  return write(() => api<SecurityRequest>(`/api/admin/security/requests/${id.parse(requestId)}/reject`, { method: "POST", json: body }))
}

export async function freezeBusinessMoneyOut(businessId: string, input: { reason: string }) {
  const body = z.object({ reason: note }).parse(input)
  return write(() => api<null>(`/api/admin/businesses/${id.parse(businessId)}/money-out/freeze`, { method: "POST", json: body }))
}

export async function unfreezeBusinessMoneyOut(businessId: string, input: { note: string }) {
  const body = z.object({ note }).parse(input)
  return write(() => api<null>(`/api/admin/businesses/${id.parse(businessId)}/money-out/unfreeze`, { method: "POST", json: body }))
}

/** After a "This wasn't me" report (or a code lockout), once staff have checked the person. */
export async function clearUserHold(userId: string, input: { note: string }) {
  const body = z.object({ note }).parse(input)
  return write(() => api<null>(`/api/admin/users/${id.parse(userId)}/security/clear-hold`, { method: "POST", json: body }))
}
