"use server"

import { revalidatePath } from "next/cache"
import { runAction } from "@/lib/action"
import type { ActionResult } from "@/lib/action-result"
import { api } from "@/lib/api/client"
import type { Branch } from "@/lib/api/types"
import { setBranchCookie } from "@/lib/branches"
import { branchSchema } from "@/lib/schemas"

/** Drops blank strings and empty groups: the API treats every field but the name as optional. */
function toBody(input: unknown) {
  const values = branchSchema.parse(input)
  const compact = (o: Record<string, string | undefined>) => {
    const entries = Object.entries(o).filter(([, v]) => v)
    return entries.length ? Object.fromEntries(entries) : undefined
  }
  return { name: values.name, address: compact(values.address), manager: compact(values.manager) }
}

async function save(fn: () => Promise<Branch>): Promise<ActionResult<Branch>> {
  const result = await runAction(fn)
  if (!result.ok && result.code === "BRANCH_NAME_TAKEN") {
    // Shown under the name field only (applyResult adds a summary banner whenever a code is set).
    return { ok: false, error: result.error, fieldErrors: { name: result.error } }
  }
  // Branches appear in the sidebar switcher and on Accounts, so refresh the whole dashboard.
  if (result.ok) revalidatePath("/", "layout")
  return result
}

/** Adds a branch. The backend opens its account straight away (or records that setup is pending). */
export async function createBranch(input: unknown) {
  const body = toBody(input)
  return save(() => api<Branch>("/api/branches", { method: "POST", json: body }))
}

export async function updateBranch(id: string, input: unknown) {
  const body = toBody(input)
  return save(() => api<Branch>(`/api/branches/${encodeURIComponent(id)}`, { method: "PATCH", json: body }))
}

/** Switcher: remembers the chosen branch (null for all branches) and re-renders with it. */
export async function selectBranch(branchId: string | null) {
  await setBranchCookie(branchId)
  revalidatePath("/", "layout")
}
