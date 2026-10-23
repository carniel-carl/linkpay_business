import type { ApprovalLevelStatus, TransferKind, TransferSettings, TransferStatus } from "@/lib/api/types"
import { formatNaira } from "@/lib/format"

/**
 * The Transfers page keeps its state in the URL (?tab=&q=&page=&size=&batch=&transfer=), like Transactions.
 * Shared by the server page and the client view.
 */

export const TABS = ["all", "awaiting", "pending_approval", "processing", "success", "failed"] as const
export type TransferTab = (typeof TABS)[number]

export const TAB_LABELS: Record<TransferTab, string> = {
  all: "All",
  awaiting: "Needs your approval",
  pending_approval: "Waiting for approval",
  processing: "In progress",
  success: "Completed",
  failed: "Failed",
}

export const STATUS_LABELS: Record<TransferStatus, string> = {
  pending_approval: "Awaiting approval",
  rejected: "Rejected",
  cancelled: "Cancelled",
  processing: "In progress",
  success: "Sent",
  failed: "Failed",
}

export const LEVEL_STATUS_LABELS: Record<ApprovalLevelStatus, string> = {
  approved: "Approved",
  waiting: "Waiting",
  upcoming: "Next",
  rejected: "Rejected",
  cancelled: "Cancelled",
  not_reached: "Not reached",
}

/** "Needs 2 approvals" for a fee quote's `approvalLevels`. */
export const approvalsNeeded = (levels: number) => (levels === 1 ? "Needs 1 approval" : `Needs ${levels} approvals`)

export const KIND_LABELS: Record<TransferKind, string> = {
  bank: "Bank transfer",
  internal: "Between branches",
  linkpay: "To a LinkPay business",
}

/** "Large transfers need approval" style summary of the rule. Used in the page header (server). */
export function describeApprovalRule({ approval }: TransferSettings) {
  if (approval.mode === "workflow" && approval.tiers.length) {
    const lowest = approval.tiers[0]
    const most = Math.max(...approval.tiers.map((t) => t.levels.length))
    const from = lowest.minKobo > 0 ? `from ${formatNaira(lowest.minKobo)}` : ""
    return `Transfers ${from ? `${from} ` : ""}go through ${most === 1 ? "one approval level" : `up to ${most} approval levels`}, depending on the amount.`
  }
  if (approval.mode === "always") return "Every transfer needs a second person's approval."
  if (approval.mode === "above_threshold" && approval.thresholdKobo !== null) {
    return `Transfers of ${formatNaira(approval.thresholdKobo)} or more need a second person's approval.`
  }
  return "Only transfers prepared by team members who can't approve need approval."
}

export const PAGE_SIZES = [10, 20, 50, 100] as const
export const DEFAULT_PAGE_SIZE = 20

export type TransferQuery = {
  tab: TransferTab
  q?: string
  /** Narrows the list to one bulk transfer. */
  batch?: string
  /** Opens this transfer's details (links in approval emails). */
  transfer?: string
  page: number
  size: number
}

type RawParams = Record<string, string | string[] | undefined>
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)
const ID = /^[a-f\d]{24}$/i

export function parseTransferQuery(params: RawParams): TransferQuery {
  const tab = one(params.tab)
  const size = Number(one(params.size))
  const batch = one(params.batch)
  const transfer = one(params.transfer)
  return {
    tab: (TABS as readonly string[]).includes(tab ?? "") ? (tab as TransferTab) : "all",
    q: one(params.q)?.trim().slice(0, 100) || undefined,
    batch: batch && ID.test(batch) ? batch : undefined,
    transfer: transfer && ID.test(transfer) ? transfer : undefined,
    page: Math.max(1, Math.trunc(Number(one(params.page))) || 1),
    size: (PAGE_SIZES as readonly number[]).includes(size) ? size : DEFAULT_PAGE_SIZE,
  }
}

/** Query string for GET /api/transfers. */
export function toApiParams(q: TransferQuery, branchId?: string) {
  const params = new URLSearchParams({ skip: String((q.page - 1) * q.size), take: String(q.size) })
  if (q.tab === "awaiting") params.set("awaiting", "me")
  else if (q.tab !== "all") params.set("status", q.tab)
  if (branchId) params.set("branch", branchId)
  if (q.batch) params.set("batch", q.batch)
  if (q.q) params.set("q", q.q)
  return params
}

/**
 * Parses a naira amount typed by a person ("1,250.50", "₦5000") into integer kobo, or null.
 * String arithmetic only, so no floating-point value ever holds money.
 */
export function parseNairaToKobo(input: string): number | null {
  const text = input.replace(/[₦,\s]/g, "")
  const match = /^(\d{1,12})(?:\.(\d{0,2}))?$/.exec(text)
  if (!match) return null
  const kobo = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"))
  return Number.isSafeInteger(kobo) ? kobo : null
}

/**
 * What a naira input shows while typing: "2000000.5" -> "2,000,000.5". Keeps digits and the first
 * point, at most 12 naira digits and 2 kobo digits, so the result always parses with parseNairaToKobo.
 */
export function formatNairaInput(input: string): string {
  const text = input.replace(/[^\d.]/g, "")
  const dot = text.indexOf(".")
  const whole = (dot < 0 ? text : text.slice(0, dot)).replace(/^0+(?=\d)/, "").slice(0, 12)
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  if (dot < 0) return grouped
  return `${grouped || "0"}.${text.slice(dot + 1).replace(/\./g, "").slice(0, 2)}`
}

/** Rows per name-enquiry call when a bulk transfer is checked before sending (a few calls, so progress shows). */
export const BULK_CHECK_SLICE = 50

/** The most one transfer can send (the API's limit per transfer, also per bulk row). */
export const MAX_TRANSFER_KOBO = 100_000_000_00

/** 123456 -> "1234.56", for putting a kobo amount back into an input. */
export const koboToInput = (kobo: number) => `${Math.trunc(kobo / 100)}.${String(kobo % 100).padStart(2, "0")}`
