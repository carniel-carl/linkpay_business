import "server-only"
import { cache } from "react"
import { redirect } from "next/navigation"
import { api } from "@/lib/api/client"
import { ApiError } from "@/lib/api/errors"
import { fetchAccounts } from "@/lib/accounts"
import { getSelectedBranch } from "@/lib/branches"
import { toApiParams, type AdminListQuery } from "@/lib/admin"
import type {
  AdminBusinessList,
  AdminSummary,
  Branch,
  Invite,
  MembershipSummary,
  Overview,
  RolesResponse,
  TeamMember,
  TransactionList,
  TransactionSummary,
  Transfer,
  TransferBatch,
  TransferList,
  TransferSettings,
  User,
} from "@/lib/api/types"

// Server Components can't change cookies, so an expired session goes through the
// sign-out route handler, which clears the cookie and redirects to sign in.
function onReadError(err: unknown): never {
  if (err instanceof ApiError && err.sessionExpired) redirect("/auth/sign-out?expired=1")
  throw err
}

export const getMe = cache(async () => {
  try {
    return await api<User>("/api/auth/me")
  } catch (err) {
    onReadError(err)
  }
})

/** The signed-in user's business, or null if they haven't created one yet. */
export const getOverview = cache(async (): Promise<Overview | null> => {
  try {
    return await api<Overview>("/api/business")
  } catch (err) {
    if (err instanceof ApiError && err.code === "BUSINESS_REQUIRED") return null
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

/** Status counts for the staff sidebar and the review queue. */
export const getAdminSummary = cache(async () => {
  try {
    return await api<AdminSummary>("/api/admin/summary")
  } catch (err) {
    onReadError(err)
  }
})

export async function getAdminBusiness(id: string) {
  try {
    return await api<Overview>(`/api/admin/businesses/${encodeURIComponent(id)}`)
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 400)) return null
    onReadError(err)
  }
}

/** The branch picked in the sidebar switcher, or null for "All branches". */
export const getSelected = cache(async () => {
  const overview = await getOverview()
  return overview ? getSelectedBranch(overview.branches ?? []) : null
})

/**
 * Accounts with balances for the signed-in business, as a UI state (see lib/accounts.ts),
 * narrowed to the selected branch when there is one.
 */
export const getAccounts = cache(async () => {
  try {
    return await fetchAccounts((await getSelected())?._id)
  } catch (err) {
    onReadError(err)
  }
})

/** GET /api/branches (approved businesses only). Also creates the head office for older businesses. */
export const getBranches = cache(async () => {
  try {
    return await api<Branch[]>("/api/branches")
  } catch (err) {
    onReadError(err)
  }
})

/** Every business the user belongs to. Only drives the business switcher, so a failure hides it. */
export const getMemberships = cache(async (): Promise<MembershipSummary[]> => {
  try {
    return await api<MembershipSummary[]>("/api/memberships")
  } catch (err) {
    if (err instanceof ApiError && err.sessionExpired) onReadError(err)
    return []
  }
})

/** The Team page's data. Needs `team.manage`: check with can() before calling. */
export async function getTeam() {
  try {
    const [members, invites, roles] = await Promise.all([
      api<TeamMember[]>("/api/team/members"),
      api<Invite[]>("/api/team/invites"),
      api<RolesResponse>("/api/team/roles"),
    ])
    return { members, invites, roles }
  } catch (err) {
    onReadError(err)
  }
}

/** A read that can fail without breaking the page. `provider_down` matches the Accounts screens' notice. */
export type Loaded<T> = { ok: true; data: T } | { ok: false; reason: "provider_down" | "unavailable" }

async function load<T>(path: string): Promise<Loaded<T>> {
  try {
    return { ok: true, data: await api<T>(path) }
  } catch (err) {
    if (!(err instanceof ApiError)) throw err
    if (err.sessionExpired) onReadError(err)
    const down = err.code === "PROVIDER_ERROR" || err.code === "API_UNREACHABLE" || err.status >= 500
    return { ok: false, reason: down ? "provider_down" : "unavailable" }
  }
}

/** GET /api/transactions (see lib/transactions.ts for the query). Needs `accounts.view`. */
export const getTransactions = (params: URLSearchParams) => load<TransactionList>(`/api/transactions?${params}`)

/** Money in and out for a period, successful transactions only. */
export const getTransactionSummary = (params: URLSearchParams) =>
  load<TransactionSummary>(`/api/transactions/summary?${params}`)

/** GET /api/transfers (see lib/transfers.ts for the query). Needs `accounts.view`. */
export const getTransfers = (params: URLSearchParams) => load<TransferList>(`/api/transfers?${params}`)

export const getTransfer = (id: string) => load<Transfer>(`/api/transfers/${encodeURIComponent(id)}`)

export const getTransferBatch = (id: string) => load<TransferBatch>(`/api/transfers/batches/${encodeURIComponent(id)}`)

/** How many transfers wait for the signed-in member's approval (0 when they can't approve). */
export const getAwaitingApprovalCount = cache(async () => {
  const result = await load<TransferList>("/api/transfers?awaiting=me&take=1")
  return result.ok ? result.data.total : 0
})

export const getTransferSettings = cache(() => load<TransferSettings>("/api/transfers/settings"))
