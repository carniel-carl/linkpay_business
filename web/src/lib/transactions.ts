import type { TransactionDirection, TransactionStatus } from "@/lib/api/types"

/**
 * The Transactions page keeps its state in the URL (?period=&from=&to=&status=&direction=&q=&branch=&page=&size=),
 * so views can be bookmarked and the back button works. Shared by the server page and the client view.
 * Periods are calendar days in Lagos time.
 */

export const PERIODS = ["today", "7d", "month", "last_month", "all", "custom"] as const
export type Period = (typeof PERIODS)[number]
export const DEFAULT_PERIOD: Period = "month"

export const PERIOD_LABELS: Record<Period, string> = {
  today: "Today",
  "7d": "Last 7 days",
  month: "This month",
  last_month: "Last month",
  all: "All time",
  custom: "Custom range",
}

export const TRANSACTION_STATUSES: TransactionStatus[] = ["success", "pending", "failed", "reversed"]
export const STATUS_LABELS: Record<TransactionStatus, string> = {
  success: "Successful",
  pending: "Pending",
  failed: "Failed",
  reversed: "Reversed",
}

export const DIRECTION_LABELS: Record<TransactionDirection, string> = { credit: "Money in", debit: "Money out" }

export const PAGE_SIZES = [10, 20, 50, 100] as const
export const DEFAULT_PAGE_SIZE = 20

export type TransactionQuery = {
  period: Period
  /** YYYY-MM-DD, custom period only. */
  from?: string
  to?: string
  status?: TransactionStatus
  direction?: TransactionDirection
  q?: string
  /** From the URL (e.g. "View transactions" on Accounts). Otherwise the switcher's branch applies. */
  branch?: string
  page: number
  size: number
}

type RawParams = Record<string, string | string[] | undefined>
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)
const DAY = /^\d{4}-\d{2}-\d{2}$/
const isDay = (v?: string): v is string => !!v && DAY.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`))

export function parseTransactionQuery(params: RawParams): TransactionQuery {
  const period = one(params.period)
  const status = one(params.status)
  const direction = one(params.direction)
  const size = Number(one(params.size))
  let from = one(params.from)
  let to = one(params.to)
  if (!isDay(from)) from = undefined
  if (!isDay(to)) to = undefined
  if (from && to && from > to) [from, to] = [to, from]
  const parsedPeriod = (PERIODS as readonly string[]).includes(period ?? "") ? (period as Period) : DEFAULT_PERIOD
  const custom = parsedPeriod === "custom" && (from || to)

  return {
    // A custom period without dates means nothing; fall back to the default.
    period: parsedPeriod === "custom" && !custom ? DEFAULT_PERIOD : parsedPeriod,
    from: custom ? from : undefined,
    to: custom ? to : undefined,
    status: (TRANSACTION_STATUSES as string[]).includes(status ?? "") ? (status as TransactionStatus) : undefined,
    direction: direction === "credit" || direction === "debit" ? direction : undefined,
    q: one(params.q)?.trim().slice(0, 100) || undefined,
    branch: one(params.branch)?.trim() || undefined,
    page: Math.max(1, Math.trunc(Number(one(params.page))) || 1),
    size: (PAGE_SIZES as readonly number[]).includes(size) ? size : DEFAULT_PAGE_SIZE,
  }
}

/** Filters beyond the period and branch (the ones "Clear filters" removes). */
export const hasFilters = (q: TransactionQuery) => !!(q.status || q.direction || q.q)

// ---- Lagos calendar days (UTC+1, no daylight saving) ----

const lagosDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos", year: "numeric", month: "2-digit", day: "2-digit" })

/** Today's date in Lagos, YYYY-MM-DD. */
export const todayInLagos = (now = new Date()) => lagosDay.format(now)

/** Midnight at the start of a Lagos day. */
const startOf = (day: string) => new Date(`${day}T00:00:00+01:00`)

function addDays(day: string, days: number) {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function addMonths(day: string, months: number) {
  const d = new Date(`${day.slice(0, 7)}-01T00:00:00Z`)
  d.setUTCMonth(d.getUTCMonth() + months)
  return d.toISOString().slice(0, 10)
}

/** The period as instants for the API. `to` is left open for periods that run until now. */
export function periodRange(q: Pick<TransactionQuery, "period" | "from" | "to">, now = new Date()): { from?: Date; to?: Date } {
  const today = todayInLagos(now)
  const monthStart = `${today.slice(0, 7)}-01`
  switch (q.period) {
    case "today":
      return { from: startOf(today) }
    case "7d":
      return { from: startOf(addDays(today, -6)) }
    case "month":
      return { from: startOf(monthStart) }
    case "last_month":
      return { from: startOf(addMonths(monthStart, -1)), to: new Date(startOf(monthStart).getTime() - 1) }
    case "custom":
      return {
        from: q.from ? startOf(q.from) : undefined,
        to: q.to ? new Date(startOf(addDays(q.to, 1)).getTime() - 1) : undefined,
      }
    case "all":
      return {}
  }
}

const dayLabel = new Intl.DateTimeFormat("en-NG", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })
const formatDay = (day: string) => dayLabel.format(new Date(`${day}T00:00:00Z`))

/** "This month", or "3 Sept 2026 to 20 Sept 2026" for a custom range. */
export function periodLabel(q: Pick<TransactionQuery, "period" | "from" | "to">) {
  if (q.period !== "custom") return PERIOD_LABELS[q.period]
  if (q.from && q.to) return q.from === q.to ? formatDay(q.from) : `${formatDay(q.from)} to ${formatDay(q.to)}`
  return q.from ? `Since ${formatDay(q.from)}` : `Until ${formatDay(q.to!)}`
}

/** Query string for GET /api/transactions (and /summary, which ignores paging, status and direction). */
export function toApiParams(q: TransactionQuery, branchId: string | undefined, now = new Date()) {
  const params = new URLSearchParams({ skip: String((q.page - 1) * q.size), take: String(q.size) })
  const { from, to } = periodRange(q, now)
  if (from) params.set("from", from.toISOString())
  if (to) params.set("to", to.toISOString())
  if (branchId) params.set("branch", branchId)
  if (q.status) params.set("status", q.status)
  if (q.direction) params.set("direction", q.direction)
  if (q.q) params.set("q", q.q)
  return params
}

export function summaryParams(q: Pick<TransactionQuery, "period" | "from" | "to">, branchId: string | undefined, now = new Date()) {
  const params = new URLSearchParams()
  const { from, to } = periodRange(q, now)
  if (from) params.set("from", from.toISOString())
  if (to) params.set("to", to.toISOString())
  if (branchId) params.set("branch", branchId)
  return params
}
