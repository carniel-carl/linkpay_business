import "server-only"
import { cache } from "react"
import { redirect } from "next/navigation"
import { api } from "@/lib/api/client"
import { ApiError } from "@/lib/api/errors"
import { fetchAccounts } from "@/lib/accounts"
import { getSelectedBranch } from "@/lib/branches"
import type {
  Branch,
  Branding,
  Invite,
  Invoice,
  InvoiceCustomer,
  InvoiceDefaults,
  InvoiceList,
  InvoiceSummary,
  LinkCheckout,
  LinkCheckoutList,
  MembershipSummary,
  Overview,
  PaymentLink,
  PaymentLinkEmbed,
  PaymentLinkList,
  PaymentLinkSummary,
  Pocket,
  PocketList,
  Safelock,
  SafelockLimits,
  SafelockList,
  RolesResponse,
  TeamMember,
  TransactionList,
  TransactionSummary,
  Approver,
  Transfer,
  TransferBatch,
  TransferList,
  TransferSettings,
  UnreadCount,
  User,
} from "@/lib/api/types"
import type { BeneficiaryList, PayoutList, PayoutListWithItems } from "@/lib/api/types"

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
    // A valid token for an account that no longer exists (a restarted mock API, a deleted user) is a 404:
    // treat it as signed out rather than crashing every page.
    if (err instanceof ApiError && err.authed && err.status === 404) redirect("/auth/sign-out?expired=1")
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

/** The bell's starting count. The live stream corrects it once connected, so a failure here is just 0. */
export const getUnreadNotificationCount = cache(async () => {
  try {
    return (await api<UnreadCount>("/api/notifications/unread-count")).total
  } catch (err) {
    if (err instanceof ApiError && err.sessionExpired) onReadError(err)
    return 0
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

/** How many transfers are waiting for approval at any level, across the member's branches. */
export const getPendingApprovalCount = cache(async () => {
  const result = await load<TransferList>("/api/transfers?approval=pending&take=1")
  return result.ok ? result.data.total : 0
})

/** People who can be named at a workflow level. Needs `transfers.manage`. */
export const getApprovers = () => load<Approver[]>("/api/transfers/approvers")

/** GET /api/invoices (see lib/invoices.ts for the query). Needs `accounts.view`. */
export const getInvoices = (params: URLSearchParams) => load<InvoiceList>(`/api/invoices?${params}`)

export const getInvoiceSummary = (params: URLSearchParams) => load<InvoiceSummary>(`/api/invoices/summary?${params}`)

/** One invoice, or null when it doesn't exist or isn't in the member's branches. */
export async function getInvoice(id: string) {
  try {
    return await api<Invoice>(`/api/invoices/${encodeURIComponent(id)}`)
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 400)) return null
    onReadError(err)
  }
}

/** The saved customers for the editor's picker (the first 100, A to Z). */
export const getInvoiceCustomers = () => load<{ items: InvoiceCustomer[]; total: number }>("/api/invoices/customers?take=100")

/** What a new invoice starts with: dates, VAT, notes and terms from the branding settings, and the next number. */
export const getInvoiceDefaults = () => load<InvoiceDefaults>("/api/invoices/defaults")

/** How the business's invoices look (logo, accent colour, defaults). */
export const getBranding = cache(() => load<Branding>("/api/branding"))

/** GET /api/pockets for a branch (or every branch the member sees). Needs `accounts.view`. */
export const getPockets = (status: "active" | "closed", branchId?: string) => {
  const params = new URLSearchParams({ status })
  if (branchId) params.set("branch", branchId)
  return load<PocketList>(`/api/pockets?${params}`)
}

/** One pocket, for links to a pocket that isn't in the list on screen (a closed one, or another branch's). */
export const getPocket = (id: string) => load<Pocket>(`/api/pockets/${encodeURIComponent(id)}`)

/** GET /api/safelocks for a branch (or every branch the member sees). Needs `accounts.view`. */
export const getSafelocks = (status: "locked" | "released", branchId?: string) => {
  const params = new URLSearchParams({ status })
  if (branchId) params.set("branch", branchId)
  return load<SafelockList>(`/api/safelocks?${params}`)
}

/** One Safelock, for links (the release notification) to one that isn't in the list on screen. */
export const getSafelock = (id: string) => load<Safelock>(`/api/safelocks/${encodeURIComponent(id)}`)

/** Amount and date limits for new Safelocks. */
export const getSafelockLimits = cache(() => load<SafelockLimits>("/api/safelocks/limits"))

/** GET /api/payment-links (see lib/payment-links.ts for the query). Needs `accounts.view`. */
export const getPaymentLinks = (params: URLSearchParams) => load<PaymentLinkList>(`/api/payment-links?${params}`)

export const getPaymentLinkSummary = (branchId?: string) =>
  load<PaymentLinkSummary>(`/api/payment-links/summary${branchId ? `?branch=${encodeURIComponent(branchId)}` : ""}`)

/** One link, or null when it doesn't exist or isn't in the member's branches. */
export async function getPaymentLink(id: string) {
  try {
    return await api<PaymentLink>(`/api/payment-links/${encodeURIComponent(id)}`)
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 400)) return null
    onReadError(err)
  }
}

/** Code for the business's website: button, inline frame and the JavaScript call. */
export const getPaymentLinkEmbed = (id: string) => load<PaymentLinkEmbed>(`/api/payment-links/${encodeURIComponent(id)}/embed`)

/** Payers' checkouts, for one link or across links. */
export const getLinkCheckouts = (params: URLSearchParams) => load<LinkCheckoutList>(`/api/payment-links/checkouts?${params}`)

/** One checkout, for links (the notification) to one that isn't in the list on screen. */
export const getLinkCheckout = (id: string) => load<LinkCheckout>(`/api/payment-links/checkouts/${encodeURIComponent(id)}`)

// ---- Beneficiaries and payout lists (docs/briefs/bulk-payouts.md). Reads need `accounts.view`. ----

/** GET /api/beneficiaries (see lib/payouts.ts for the query). */
export const getBeneficiaries = (params: URLSearchParams) => load<BeneficiaryList>(`/api/beneficiaries?${params}`)

/** The lists the member can use (their branches' and those with no branch), most recently changed first. */
export const getPayoutLists = () => load<{ items: PayoutList[] }>("/api/payout-lists")

/** One list with its rows, or null when it doesn't exist or is for a branch the member can't see. */
export async function getPayoutList(id: string) {
  try {
    return await api<PayoutListWithItems>(`/api/payout-lists/${encodeURIComponent(id)}`)
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 400)) return null
    onReadError(err)
  }
}
