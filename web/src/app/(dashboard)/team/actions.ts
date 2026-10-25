"use server"

import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"
import { runAction } from "@/lib/action"
import type { ActionResult } from "@/lib/action-result"
import { api } from "@/lib/api/client"
import { pinHeader } from "@/lib/api/transaction-pin"
import type { Invite, TeamMember } from "@/lib/api/types"
import { getBusinessCookie, setBusinessCookie } from "@/lib/business-context"
import { accessSchema, inviteSchema } from "@/lib/schemas"

const member = (id: string) => `/api/team/members/${encodeURIComponent(id)}`
const invite = (id: string) => `/api/team/invites/${encodeURIComponent(id)}`

/** "All branches" is an empty list. The backend ignores branches for business-wide roles. */
const branchesFor = (v: { allBranches: boolean; branches: string[] }) => (v.allBranches ? [] : v.branches)

async function change<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  const result = await runAction(fn)
  // A member's role or branches change what the whole dashboard shows them, so refresh everything.
  if (result.ok) revalidatePath("/", "layout")
  return result
}

// Inviting, resending, changing access and removing someone take the member's transaction PIN (the
// X-Transaction-Pin header). Revoking an invite and leaving don't.

export async function inviteMember(input: unknown, pin: string) {
  const v = inviteSchema.parse(input)
  const result = await change(() =>
    api<Invite>("/api/team/invites", {
      method: "POST",
      json: { email: v.email, role: v.role, branches: branchesFor(v) },
      headers: pinHeader(pin),
    }),
  )
  // These are about the email, so show them under the field.
  if (!result.ok && (result.code === "ALREADY_MEMBER" || result.code === "INVITE_EXISTS")) {
    return { ok: false, error: result.error, fieldErrors: { email: result.error } } satisfies ActionResult<Invite>
  }
  return result
}

/** Role and branches together: moving someone to a branch-limited role needs a branch choice. */
export async function updateMemberAccess(id: string, input: unknown, pin: string) {
  const v = accessSchema.parse(input)
  return change(() =>
    api<TeamMember>(member(id), { method: "PATCH", json: { role: v.role, branches: branchesFor(v) }, headers: pinHeader(pin) }),
  )
}

export async function removeMember(id: string, pin: string) {
  return change(() => api<null>(member(id), { method: "DELETE", headers: pinHeader(pin) }))
}

/** Sends a fresh link (the old one stops working). The backend allows one resend a minute. */
export async function resendInvite(id: string, pin: string) {
  return change(() => api<Invite>(`${invite(id)}/resend`, { method: "POST", headers: pinHeader(pin) }))
}

export async function revokeInvite(id: string) {
  return change(() => api<null>(invite(id), { method: "DELETE" }))
}

/**
 * Leaves the business the page showed (sent as X-Business-Id, so a switch in another tab can't change which) and
 * goes on to the user's default business, or onboarding if there's none. Works for a suspended or closed business too.
 */
export async function leaveBusiness(businessId: string): Promise<ActionResult> {
  const result = await runAction(() => api<null>("/api/team/leave", { method: "POST", businessId }))
  if (!result.ok) return { ok: false, error: result.error, code: result.code }
  // No cookie means the default business, which was this one. A cookie for another business stays.
  const chosen = await getBusinessCookie()
  if (!chosen || chosen === businessId) await setBusinessCookie(null)
  revalidatePath("/", "layout")
  redirect("/dashboard")
}
