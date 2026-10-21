import type {
  AuditAction,
  ComplianceStatus,
  FlagSeverity,
  TransactionDirection,
  TransactionStatus,
  TransferKind,
  TransferStatus,
} from "@/lib/api/types"

/**
 * Labels and URL state for the compliance and activity screens (docs/briefs/compliance.md). Each list keeps
 * its filters in the URL, like the businesses table, so views can be shared and the back button works.
 */

// ---- Labels ----

/** "banned" is "Closed" everywhere staff read it. */
export const COMPLIANCE_LABELS: Record<ComplianceStatus, string> = {
  active: "Active",
  suspended: "Suspended",
  banned: "Closed",
}

export const SEVERITIES: FlagSeverity[] = ["high", "medium", "low"]
export const SEVERITY_LABELS: Record<FlagSeverity, string> = { high: "High", medium: "Medium", low: "Low" }

export const OUTCOME_LABELS = { cleared: "Cleared", actioned: "Actioned" } as const

export const TRANSACTION_STATUS_LABELS: Record<TransactionStatus, string> = {
  success: "Successful",
  pending: "Pending",
  failed: "Failed",
  reversed: "Reversed",
}
export const DIRECTION_LABELS: Record<TransactionDirection, string> = { credit: "Money in", debit: "Money out" }

export const TRANSFER_STATUS_LABELS: Record<TransferStatus, string> = {
  pending_approval: "Awaiting approval",
  processing: "In progress",
  success: "Sent",
  failed: "Failed",
  rejected: "Rejected",
  cancelled: "Cancelled",
}
export const TRANSFER_KIND_LABELS: Record<TransferKind, string> = {
  bank: "Bank transfer",
  internal: "Between branches",
  linkpay: "To a LinkPay business",
}

export const AUDIT_ACTION_LABELS: Record<AuditAction, string> = {
  "kyb.approved": "Verification approved",
  "kyb.changes_requested": "Changes requested",
  "kyb.rejected": "Verification rejected",
  "account.provision_retried": "Account setup retried",
  "flag.raised": "Flag raised",
  "flag.resolved": "Flag resolved",
  "note.added": "Note added",
  "business.suspended": "Suspended",
  "business.reinstated": "Reinstated",
  "business.banned": "Closed",
  "business.unbanned": "Ban lifted",
  "staff.invited": "Staff invited",
  "staff.invite_revoked": "Staff invite revoked",
  "staff.role_changed": "Staff role changed",
  "staff.disabled": "Staff turned off",
  "staff.enabled": "Staff turned on",
  "staff.signed_out": "Staff signed out",
}
export const AUDIT_ACTIONS = Object.keys(AUDIT_ACTION_LABELS) as AuditAction[]

/** "24 hours", "1 hour", "30 days". */
export function windowLabel(hours: number) {
  if (hours % 24 === 0 && hours >= 48) return `${hours / 24} days`
  return hours === 1 ? "1 hour" : `${hours} hours`
}

// ---- URL helpers ----

type RawParams = Record<string, string | string[] | undefined>
export const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)
const pick = <T extends string>(value: string | undefined, allowed: readonly T[]) =>
  allowed.includes(value as T) ? (value as T) : undefined
const objectId = (v: string | undefined) => (v && /^[0-9a-f]{24}$/i.test(v) ? v : undefined)
const day = (v: string | undefined) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined)
const text = (v: string | undefined) => v?.trim().slice(0, 100) || undefined
const page = (v: string | undefined) => Math.max(1, Math.trunc(Number(v)) || 1)

/** Whole naira typed into "Amount from" (commas allowed) as kobo. */
export function nairaToKobo(v: string | undefined) {
  const n = Number(v?.replace(/[₦,\s]/g, ""))
  return Number.isSafeInteger(n) && n > 0 ? n * 100 : undefined
}

// Lagos is UTC+1 all year, so a calendar day there runs from 23:00 UTC the day before.
const startOfDay = (d: string) => new Date(`${d}T00:00:00+01:00`).toISOString()
const endOfDay = (d: string) => new Date(new Date(`${d}T00:00:00+01:00`).getTime() + 86_400_000 - 1).toISOString()

export const PAGE_SIZE = 25

// ---- Compliance page: flags queue ----

export const FLAG_STATUSES = ["open", "resolved", "all"] as const
export type FlagQuery = {
  status: (typeof FLAG_STATUSES)[number]
  severity?: FlagSeverity
  source?: "rule" | "staff"
  rule?: string
  page: number
}

export function parseFlagQuery(params: RawParams): FlagQuery {
  return {
    status: pick(one(params.status), FLAG_STATUSES) ?? "open",
    severity: pick(one(params.severity), SEVERITIES),
    source: pick(one(params.source), ["rule", "staff"] as const),
    rule: text(one(params.rule))?.replace(/[^a-z_]/g, "") || undefined,
    page: page(one(params.page)),
  }
}

export function flagApiParams(q: FlagQuery) {
  const p = new URLSearchParams({ status: q.status, skip: String((q.page - 1) * PAGE_SIZE), take: String(PAGE_SIZE) })
  if (q.severity) p.set("severity", q.severity)
  if (q.source) p.set("source", q.source)
  if (q.rule) p.set("rule", q.rule)
  return p
}

// ---- Payments (one business, or the platform feed) ----

export type PaymentQuery = {
  direction?: TransactionDirection
  status?: TransactionStatus
  /** Whole naira, as typed. */
  min?: string
  from?: string
  to?: string
  q?: string
  page: number
}

export function parsePaymentQuery(params: RawParams): PaymentQuery {
  return {
    direction: pick(one(params.direction), ["credit", "debit"] as const),
    status: pick(one(params.status), ["success", "pending", "failed", "reversed"] as const),
    min: nairaToKobo(one(params.min)) ? one(params.min) : undefined,
    from: day(one(params.from)),
    to: day(one(params.to)),
    q: text(one(params.q)),
    page: page(one(params.page)),
  }
}

export function paymentApiParams(q: PaymentQuery) {
  const p = new URLSearchParams({ skip: String((q.page - 1) * PAGE_SIZE), take: String(PAGE_SIZE) })
  if (q.direction) p.set("direction", q.direction)
  if (q.status) p.set("status", q.status)
  const min = nairaToKobo(q.min)
  if (min) p.set("minKobo", String(min))
  if (q.from) p.set("from", startOfDay(q.from))
  if (q.to) p.set("to", endOfDay(q.to))
  if (q.q) p.set("q", q.q)
  return p
}

// ---- Transfers of one business ----

export type TransferQuery = {
  status?: TransferStatus
  kind?: TransferKind
  min?: string
  from?: string
  to?: string
  q?: string
  page: number
}

export function parseTransferQuery(params: RawParams): TransferQuery {
  return {
    status: pick(one(params.status), Object.keys(TRANSFER_STATUS_LABELS) as TransferStatus[]),
    kind: pick(one(params.kind), Object.keys(TRANSFER_KIND_LABELS) as TransferKind[]),
    min: nairaToKobo(one(params.min)) ? one(params.min) : undefined,
    from: day(one(params.from)),
    to: day(one(params.to)),
    q: text(one(params.q)),
    page: page(one(params.page)),
  }
}

export function transferApiParams(q: TransferQuery) {
  const p = new URLSearchParams({ skip: String((q.page - 1) * PAGE_SIZE), take: String(PAGE_SIZE) })
  if (q.status) p.set("status", q.status)
  if (q.kind) p.set("kind", q.kind)
  const min = nairaToKobo(q.min)
  if (min) p.set("minKobo", String(min))
  if (q.from) p.set("from", startOfDay(q.from))
  if (q.to) p.set("to", endOfDay(q.to))
  if (q.q) p.set("q", q.q)
  return p
}

// ---- Audit log ----

export type AuditQuery = { action?: AuditAction; staff?: string; business?: string; before?: string }

export function parseAuditQuery(params: RawParams): AuditQuery {
  return {
    action: pick(one(params.action), AUDIT_ACTIONS),
    staff: objectId(one(params.staff)),
    business: objectId(one(params.business)),
    before: objectId(one(params.before)),
  }
}

export function auditApiParams(q: AuditQuery, take = 50) {
  const p = new URLSearchParams({ take: String(take) })
  for (const key of ["action", "staff", "business", "before"] as const) if (q[key]) p.set(key, q[key]!)
  return p
}
