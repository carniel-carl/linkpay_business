import "server-only"
import { cache } from "react"
import { redirect } from "next/navigation"
import { api } from "@/lib/api/client"
import { ApiError } from "@/lib/api/errors"
import { toApiParams, type AdminListQuery } from "@/lib/admin"
import {
  auditApiParams,
  flagApiParams,
  paymentApiParams,
  transferApiParams,
  type AuditQuery,
  type FlagQuery,
  type PaymentQuery,
  type TransferQuery,
} from "@/lib/compliance"
import type {
  AdminBusinessList,
  AdminSummary,
  AdminTransfer,
  AuditPage,
  BusinessActivity,
  BusinessComplianceView,
  BusinessMembers,
  ComplianceRules,
  ComplianceSummary,
  FeedTransaction,
  FlagList,
  Overview,
  Paged,
  Transaction,
  Staff,
  StaffInvite,
  StaffMember,
  StaffRoleInfo,
} from "@/lib/api/types"

// Server Components can't change cookies, so an ended session goes through the
// sign-out route handler, which clears the cookie and redirects to sign in.
function onReadError(err: unknown): never {
  if (err instanceof ApiError && err.sessionExpired) {
    redirect(`/auth/sign-out?expired=1${err.endReason ? `&reason=${err.endReason}` : ""}`)
  }
  throw err
}

/** The signed-in staff member. */
export const getStaff = cache(async () => {
  try {
    return await api<Staff>("/api/admin/auth/me")
  } catch (err) {
    onReadError(err)
  }
})

export async function getAdminBusinesses(query: AdminListQuery) {
  try {
    return await api<AdminBusinessList>(`/api/admin/businesses?${toApiParams(query)}`)
  } catch (err) {
    onReadError(err)
  }
}

/** Status counts for the sidebar and the review queue. */
export const getAdminSummary = cache(async () => {
  try {
    return await api<AdminSummary>("/api/admin/summary")
  } catch (err) {
    onReadError(err)
  }
})

/** One business with its documents and branches. Cached per request: the header and the tabs share it. */
export const getAdminBusiness = cache(async (id: string) => {
  try {
    return await api<Overview>(`/api/admin/businesses/${encodeURIComponent(id)}`)
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 400)) return null
    onReadError(err)
  }
})

/** The staff roles with labels and descriptions. Any staff member can read them. */
export const getStaffRoles = cache(async () => {
  try {
    return await api<StaffRoleInfo[]>("/api/admin/staff/roles")
  } catch (err) {
    onReadError(err)
  }
})

/** Everyone with a staff account, oldest first (needs staff.manage). */
export async function getStaffList() {
  try {
    return await api<StaffMember[]>("/api/admin/staff")
  } catch (err) {
    onReadError(err)
  }
}

/** Open staff invites, newest first (needs staff.manage). */
export async function getStaffInvites() {
  try {
    return await api<StaffInvite[]>("/api/admin/staff/invites")
  } catch (err) {
    onReadError(err)
  }
}

/** Unread notification count for the bell. A failure shows no badge rather than breaking the page. */
export async function getUnreadNotifications() {
  try {
    return (await api<{ total: number }>("/api/admin/notifications/unread-count")).total
  } catch (err) {
    if (err instanceof ApiError && err.sessionExpired) onReadError(err)
    return 0
  }
}

// ---- Activity (activity.view) ----

const businessPath = (id: string) => `/api/admin/businesses/${encodeURIComponent(id)}`

/** Reads that 404 for an unknown business return null, so the page can show "not found". */
async function read<T>(path: string) {
  try {
    return await api<T>(path)
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 400)) return null
    onReadError(err)
  }
}

export const getBusinessActivity = (id: string) => read<BusinessActivity>(`${businessPath(id)}/activity`)

export const getBusinessTransactions = (id: string, query: PaymentQuery) =>
  read<Paged<Transaction>>(`${businessPath(id)}/transactions?${paymentApiParams(query)}`)

export const getBusinessTransfers = (id: string, query: TransferQuery) =>
  read<Paged<AdminTransfer>>(`${businessPath(id)}/transfers?${transferApiParams(query)}`)

export const getBusinessMembers = (id: string) => read<BusinessMembers>(`${businessPath(id)}/members`)

/** Every business's payments, newest first. */
export async function getPaymentsFeed(query: PaymentQuery) {
  try {
    return await api<Paged<FeedTransaction>>(`/api/admin/activity/transactions?${paymentApiParams(query)}`)
  } catch (err) {
    onReadError(err)
  }
}

// ---- Compliance (compliance.view) ----

export const getComplianceSummary = cache(async () => {
  try {
    return await api<ComplianceSummary>("/api/admin/compliance/summary")
  } catch (err) {
    onReadError(err)
  }
})

/** The automatic rules and the category and severity lists for the forms. */
export const getComplianceRules = cache(async () => {
  try {
    return await api<ComplianceRules>("/api/admin/compliance/rules")
  } catch (err) {
    onReadError(err)
  }
})

export async function getFlags(query: FlagQuery) {
  try {
    return await api<FlagList>(`/api/admin/compliance/flags?${flagApiParams(query)}`)
  } catch (err) {
    onReadError(err)
  }
}

export const getBusinessCompliance = (id: string) => read<BusinessComplianceView>(`${businessPath(id)}/compliance`)

export async function getAuditLog(query: AuditQuery) {
  try {
    return await api<AuditPage>(`/api/admin/audit?${auditApiParams(query)}`)
  } catch (err) {
    onReadError(err)
  }
}
