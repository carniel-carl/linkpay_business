"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { runAction } from "@/lib/action"
import type { ActionResult } from "@/lib/action-result"
import { api } from "@/lib/api/client"
import type { AuditEntry, AuditPage, ComplianceState, Flag, FlagDetail } from "@/lib/api/types"
import { auditApiParams } from "@/lib/compliance"

// Compliance writes (compliance.manage, bans compliance.ban) and the reads the flag sheet and the
// timeline load on demand. Contract: docs/briefs/compliance.md §4.

const id = z.string().regex(/^[0-9a-f]{24}$/i)
const business = (businessId: string) => `/api/admin/businesses/${id.parse(businessId)}`
const category = z.enum(["suspicious_transactions", "fraud_report", "identity_concern", "sanctions", "other"])
const note = z.string().trim().min(1).max(2000)

/** Runs a write and refreshes every page (sidebar counts, lists and the business's tabs all change). */
async function write<T>(fn: () => Promise<T>) {
  const result = await runAction(fn)
  if (result.ok) revalidatePath("/", "layout")
  return result
}

const STATE_LABEL = { active: "active", suspended: "suspended", banned: "closed" } as const

/**
 * A restriction that no longer applies (someone else changed it a moment ago) answers 409 with the
 * current state in the code. Say that plainly instead of the backend's "This business is banned".
 */
function explainConflict<T>(result: ActionResult<T>): ActionResult<T> {
  if (result.ok) return result
  // The shared message for NOT_APPROVED is about bank accounts.
  if (result.code === "NOT_APPROVED") {
    return { ...result, error: "Only approved businesses can be suspended. Reject the verification or close the business instead." }
  }
  const now =
    result.code === "BUSINESS_SUSPENDED" ? "suspended" : result.code === "BUSINESS_BANNED" ? "banned" : result.code === "BUSINESS_NOT_RESTRICTED" ? "active" : null
  return now ? { ...result, error: `This business is ${STATE_LABEL[now]} now. Refresh to see who changed it.` } : result
}

// ---- Flags ----

export async function getFlag(flagId: string) {
  return runAction(() => api<FlagDetail>(`/api/admin/compliance/flags/${id.parse(flagId)}`))
}

export async function resolveFlag(flagId: string, input: unknown) {
  const body = z.object({ outcome: z.enum(["cleared", "actioned"]), note }).parse(input)
  return write(() => api<Flag>(`/api/admin/compliance/flags/${id.parse(flagId)}/resolve`, { method: "POST", json: body }))
}

export async function runChecks() {
  return write(() => api<{ raised: number; byRule: Record<string, number> }>("/api/admin/compliance/run-checks", { method: "POST" }))
}

export async function raiseFlag(businessId: string, input: unknown) {
  const body = z
    .object({
      category,
      severity: z.enum(["low", "medium", "high"]),
      summary: z.string().trim().min(3).max(200),
      note: z.string().trim().max(2000).optional(),
      transactionIds: z.array(id).max(50).optional(),
      transferIds: z.array(id).max(50).optional(),
    })
    .parse(input)
  return write(() => api<Flag>(`${business(businessId)}/flags`, { method: "POST", json: { ...body, note: body.note || undefined } }))
}

// ---- Notes and restrictions ----

export async function addNote(businessId: string, input: unknown) {
  const body = z.object({ body: note }).parse(input)
  return write(() => api<AuditEntry>(`${business(businessId)}/notes`, { method: "POST", json: body }))
}

type StateResponse = { business: { _id: string; name: string }; compliance: ComplianceState }
const restriction = z.object({ reason: category, note })
const lift = z.object({ note })

/** suspend / ban take a reason and a note; reinstate / unban take a note. */
export async function changeRestriction(businessId: string, action: "suspend" | "reinstate" | "ban" | "unban", input: unknown) {
  const body = action === "suspend" || action === "ban" ? restriction.parse(input) : lift.parse(input)
  const path = `${business(businessId)}/${z.enum(["suspend", "reinstate", "ban", "unban"]).parse(action)}`
  return explainConflict(await write(() => api<StateResponse>(path, { method: "POST", json: body })))
}

// ---- Timeline ----

/** Older timeline entries of one business (the compliance tab shows the 50 newest). */
export async function loadTimeline(businessId: string, before: string) {
  const query = auditApiParams({ business: id.parse(businessId), before: id.parse(before) })
  return runAction(() => api<AuditPage>(`/api/admin/audit?${query}`))
}
