"use server"

import { revalidatePath } from "next/cache"
import { runAction } from "@/lib/action"
import { api } from "@/lib/api/client"
import type { Account, Overview } from "@/lib/api/types"
import { rejectSchema, requestChangesSchema } from "@/lib/schemas"

const base = (id: string) => `/api/admin/businesses/${encodeURIComponent(id)}`

async function review(fn: () => Promise<Overview>) {
  const result = await runAction(fn)
  if (result.ok) revalidatePath("/", "layout")
  return result
}

export async function approveBusiness(id: string) {
  return review(() => api<Overview>(`${base(id)}/approve`, { method: "POST" }))
}

export async function requestChanges(id: string, input: unknown) {
  const body = requestChangesSchema.parse(input)
  return review(() => api<Overview>(`${base(id)}/request-changes`, { method: "POST", json: body }))
}

export async function rejectBusiness(id: string, input: unknown) {
  const body = rejectSchema.parse(input)
  return review(() => api<Overview>(`${base(id)}/reject`, { method: "POST", json: body }))
}

/** Retries bank account setup for an approved business. Safe to repeat; returns the account. */
export async function retryAccountSetup(id: string) {
  const result = await runAction(() => api<Account>(`${base(id)}/provision-account`, { method: "POST" }))
  // A failed attempt still changes the recorded status and error, so refresh either way.
  revalidatePath("/", "layout")
  return result
}

/** Retries account setup for one branch. Safe to repeat; returns the account. */
export async function retryBranchAccountSetup(id: string, branchId: string) {
  const result = await runAction(() =>
    api<Account>(`${base(id)}/branches/${encodeURIComponent(branchId)}/provision-account`, { method: "POST" }),
  )
  revalidatePath("/", "layout")
  return result
}
