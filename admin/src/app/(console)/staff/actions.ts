"use server"

import { revalidatePath } from "next/cache"
import { runAction } from "@/lib/action"
import { api } from "@/lib/api/client"
import type { StaffInvite, StaffMember } from "@/lib/api/types"
import { staffInviteSchema, staffRoleSchema } from "@/lib/schemas"

// The backend checks staff.manage on every call here; the page only hides what the role can't use.
const member = (id: string) => `/api/admin/staff/${encodeURIComponent(id)}`
const invite = (id: string) => `/api/admin/staff/invites/${encodeURIComponent(id)}`

async function refresh<T>(fn: () => Promise<T>) {
  const result = await runAction(fn)
  if (result.ok) revalidatePath("/staff")
  return result
}

export async function inviteStaff(input: unknown) {
  const body = staffInviteSchema.parse(input)
  return refresh(() => api<StaffInvite>("/api/admin/staff/invites", { method: "POST", json: body }))
}

export async function resendStaffInvite(id: string) {
  return refresh(() => api<StaffInvite>(`${invite(id)}/resend`, { method: "POST" }))
}

export async function revokeStaffInvite(id: string) {
  return refresh(() => api(invite(id), { method: "DELETE" }))
}

export async function changeStaffRole(id: string, input: unknown) {
  const body = staffRoleSchema.parse(input)
  return refresh(() => api<StaffMember>(member(id), { method: "PATCH", json: body }))
}

export async function disableStaff(id: string) {
  return refresh(() => api<StaffMember>(`${member(id)}/disable`, { method: "POST" }))
}

export async function enableStaff(id: string) {
  return refresh(() => api<StaffMember>(`${member(id)}/enable`, { method: "POST" }))
}

export async function signOutStaff(id: string) {
  return refresh(() => api(`${member(id)}/sign-out`, { method: "POST" }))
}
