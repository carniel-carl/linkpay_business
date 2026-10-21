import type { BrandPalette, InvoiceDiscount, InvoiceListItem, InvoiceStatus, PaymentMethod } from "@/lib/api/types"

/**
 * The Invoices page keeps its state in the URL (?tab=&q=&page=&size=), like Transfers.
 * Shared by the server pages and the client views.
 */

export const TABS = ["all", "draft", "unpaid", "overdue", "paid", "void"] as const
export type InvoiceTab = (typeof TABS)[number]

export const TAB_LABELS: Record<InvoiceTab, string> = {
  all: "All",
  draft: "Drafts",
  unpaid: "Unpaid",
  overdue: "Overdue",
  paid: "Paid",
  void: "Void",
}

export const STATUS_LABELS: Record<InvoiceStatus, string> = {
  draft: "Draft",
  open: "Unpaid",
  partially_paid: "Part paid",
  paid: "Paid",
  void: "Void",
}

export const METHOD_LABELS: Record<PaymentMethod, string> = {
  transfer: "Bank transfer",
  cash: "Cash",
  pos: "POS",
  cheque: "Cheque",
  other: "Other",
}

/** "Overdue" wins over the stored status, since it's what needs doing. */
export const statusLabel = (invoice: Pick<InvoiceListItem, "status" | "overdue">) =>
  invoice.overdue ? "Overdue" : (STATUS_LABELS[invoice.status] ?? invoice.status)

export const PAGE_SIZES = [10, 20, 50, 100] as const
export const DEFAULT_PAGE_SIZE = 20

export type InvoiceQuery = { tab: InvoiceTab; q?: string; page: number; size: number }

type RawParams = Record<string, string | string[] | undefined>
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

export function parseInvoiceQuery(params: RawParams): InvoiceQuery {
  const tab = one(params.tab)
  const size = Number(one(params.size))
  return {
    tab: (TABS as readonly string[]).includes(tab ?? "") ? (tab as InvoiceTab) : "all",
    q: one(params.q)?.trim().slice(0, 100) || undefined,
    page: Math.max(1, Math.trunc(Number(one(params.page))) || 1),
    size: (PAGE_SIZES as readonly number[]).includes(size) ? size : DEFAULT_PAGE_SIZE,
  }
}

/** Query string for GET /api/invoices. */
export function toApiParams(q: InvoiceQuery, branchId?: string) {
  const params = new URLSearchParams({ skip: String((q.page - 1) * q.size), take: String(q.size) })
  if (q.tab !== "all") params.set("status", q.tab)
  if (branchId) params.set("branch", branchId)
  if (q.q) params.set("q", q.q)
  return params
}

// ---------------------------------------------------------------------------------------------------------
// Dates: invoices use Lagos calendar days ("YYYY-MM-DD"), never times.
// ---------------------------------------------------------------------------------------------------------

const lagosDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos", year: "numeric", month: "2-digit", day: "2-digit" })
const dayFmt = new Intl.DateTimeFormat("en-NG", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })

export const todayInLagos = (now = new Date()) => lagosDay.format(now)

export function addDays(day: string, days: number) {
  const d = new Date(`${day}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000)

/** "2026-10-20" -> "20 Oct 2026" */
export const formatDay = (day?: string | null) => (day ? dayFmt.format(new Date(`${day}T12:00:00Z`)) : "")

/** "Due in 3 days", "Due today", "4 days overdue". */
export function dueLabel(dueDate: string, today = todayInLagos()) {
  const days = daysBetween(today, dueDate)
  if (days === 0) return "Due today"
  if (days === 1) return "Due tomorrow"
  if (days > 1) return `Due in ${days} days`
  return days === -1 ? "1 day overdue" : `${-days} days overdue`
}

// ---------------------------------------------------------------------------------------------------------
// Totals. Mirrors the backend's computeTotals (services/invoices.ts) for the editor's live preview; the
// backend's figures are the ones that count.
// ---------------------------------------------------------------------------------------------------------

export type DraftItem = { description: string; quantity: number; unitPriceKobo: number }

export function computeTotals(items: DraftItem[], discount: InvoiceDiscount | null, vatRateBps: number | null) {
  const lines = items.map((i) => ({ ...i, amountKobo: Math.round(i.quantity * i.unitPriceKobo) }))
  const subtotalKobo = lines.reduce((s, l) => s + l.amountKobo, 0)
  let discountKobo = 0
  if (discount?.type === "amount") discountKobo = Math.min(discount.value, subtotalKobo)
  if (discount?.type === "percent") discountKobo = Math.round((subtotalKobo * discount.value) / 10_000)
  const vatKobo = vatRateBps ? Math.round(((subtotalKobo - discountKobo) * vatRateBps) / 10_000) : 0
  return { items: lines, subtotalKobo, discountKobo, vatKobo, totalKobo: subtotalKobo - discountKobo + vatKobo }
}

/** 750 -> "7.5" */
export const bpsToPercent = (bps: number) => String(bps / 100)

/** "7.5" -> 750, or null. Up to two decimal places, 0 to 100. */
export function parsePercentToBps(input: string): number | null {
  const match = /^(\d{1,3})(?:\.(\d{0,2}))?$/.exec(input.trim().replace(/%$/, ""))
  if (!match) return null
  const bps = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"))
  return bps <= 10_000 ? bps : null
}

/** Quantities: up to 2 decimal places ("1.5" hours, "0.25" kg), as the backend allows. */
export function parseQuantity(input: string): number | null {
  const text = input.trim().replace(/,/g, "")
  if (!/^\d{1,7}(?:\.\d{0,2})?$/.test(text)) return null
  const n = Number(text)
  return n > 0 ? n : null
}

/** "Discount (10%)" for a percentage, otherwise "Discount". */
export const describeDiscount = (percentBps: number | null) => (percentBps !== null ? `Discount (${bpsToPercent(percentBps)}%)` : "Discount")

export const discountPercentBps = (discount: InvoiceDiscount | null) => (discount?.type === "percent" ? discount.value : null)

/** What the customer should put in the transfer narration so the payment matches by itself. */
export const narrationHint = (number: string) => `Use ${number} as the transfer narration so we can match your payment.`

/** The backend's neutral default (services/branding.ts), for when the branding can't be loaded. */
export const DEFAULT_ACCENT_PALETTE: BrandPalette = { accent: "#1F2937", onAccent: "#FFFFFF", accentText: "#1F2937" }

// ---------------------------------------------------------------------------------------------------------
// Accent colours. Mirrors accentPalette() in the backend's services/branding.ts so the branding preview
// recolours as you pick; the saved palette always comes from the backend.
// ---------------------------------------------------------------------------------------------------------

const channels = (hex: string) => {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255] as const
}

const toHex = (r: number, g: number, b: number) =>
  "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("").toUpperCase()

/** WCAG relative luminance. */
function luminance(hex: string) {
  const [r, g, b] = channels(hex).map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export const contrastRatio = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

export const isHexColor = (value: string) => /^#[0-9A-F]{6}$/i.test(value)

export function accentPalette(accent?: string | null): BrandPalette {
  if (!accent || !isHexColor(accent)) return DEFAULT_ACCENT_PALETTE
  const base = accent.toUpperCase()
  const onAccent = contrastRatio(base, "#FFFFFF") >= contrastRatio(base, "#111111") ? "#FFFFFF" : "#111111"
  let [r, g, b]: number[] = [...channels(base)]
  let accentText = base
  for (let i = 0; i < 20 && contrastRatio(accentText, "#FFFFFF") < 4.5; i++) {
    ;[r, g, b] = [r * 0.85, g * 0.85, b * 0.85]
    accentText = toHex(r, g, b)
  }
  return { accent: base, onAccent, accentText }
}
