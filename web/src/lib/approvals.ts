import { PERIODS, periodRange, type Period } from "@/lib/transactions"
import { DEFAULT_PAGE_SIZE, PAGE_SIZES } from "@/lib/transfers"

/**
 * The Fund approvals page keeps its state in the URL (?tab=&q=&period=&from=&to=&page=&size=&transfer=),
 * like Transfers. Shared by the server page and the client view. Periods reuse the Transactions ones.
 */

export const APPROVAL_TABS = ["pending", "approved", "rejected"] as const
export type ApprovalTab = (typeof APPROVAL_TABS)[number]

export const APPROVAL_TAB_LABELS: Record<ApprovalTab, string> = {
  pending: "Pending",
  approved: "Approved",
  rejected: "Declined",
}

/** All time by default: a transfer can wait longer than a month. */
export const APPROVALS_DEFAULT_PERIOD: Period = "all"

export type ApprovalQuery = {
  tab: ApprovalTab
  q?: string
  period: Period
  /** YYYY-MM-DD, custom period only. */
  from?: string
  to?: string
  /** Opens this transfer's details. */
  transfer?: string
  page: number
  size: number
}

type RawParams = Record<string, string | string[] | undefined>
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)
const ID = /^[a-f\d]{24}$/i
const DAY = /^\d{4}-\d{2}-\d{2}$/
const isDay = (v?: string): v is string => !!v && DAY.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`))

export function parseApprovalQuery(params: RawParams): ApprovalQuery {
  const tab = one(params.tab)
  const period = one(params.period)
  const size = Number(one(params.size))
  const transfer = one(params.transfer)
  let from = one(params.from)
  let to = one(params.to)
  if (!isDay(from)) from = undefined
  if (!isDay(to)) to = undefined
  if (from && to && from > to) [from, to] = [to, from]
  const parsedPeriod = (PERIODS as readonly string[]).includes(period ?? "") ? (period as Period) : APPROVALS_DEFAULT_PERIOD
  const custom = parsedPeriod === "custom" && (from || to)
  return {
    tab: (APPROVAL_TABS as readonly string[]).includes(tab ?? "") ? (tab as ApprovalTab) : "pending",
    q: one(params.q)?.trim().slice(0, 100) || undefined,
    period: parsedPeriod === "custom" && !custom ? APPROVALS_DEFAULT_PERIOD : parsedPeriod,
    from: custom ? from : undefined,
    to: custom ? to : undefined,
    transfer: transfer && ID.test(transfer) ? transfer : undefined,
    page: Math.max(1, Math.trunc(Number(one(params.page))) || 1),
    size: (PAGE_SIZES as readonly number[]).includes(size) ? size : DEFAULT_PAGE_SIZE,
  }
}

/** Query string for GET /api/transfers?approval=. */
export function toApprovalApiParams(q: ApprovalQuery, branchId?: string, now = new Date()) {
  const params = new URLSearchParams({ approval: q.tab, skip: String((q.page - 1) * q.size), take: String(q.size) })
  const range = periodRange(q, now)
  if (range.from) params.set("from", range.from.toISOString())
  if (range.to) params.set("to", range.to.toISOString())
  if (branchId) params.set("branch", branchId)
  if (q.q) params.set("q", q.q)
  return params
}
