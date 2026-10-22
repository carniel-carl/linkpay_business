import type { BrandPalette, CheckoutStatus, LinkCheckout, PaymentLink, PaymentLinkImage, PaymentLinkUnavailableReason, PhoneFieldMode } from "@/lib/api/types"
import { formatNaira } from "@/lib/format"

/**
 * Payment links keep their state in the URL, like Invoices:
 * /payment-links?view=links|payments&status=&q=&page=&size=, and /payment-links/<id>?status=&q=&page=&checkout=<id>.
 * Contract: docs/briefs/payment-links.md.
 */

export const LINK_TABS = ["all", "active", "inactive"] as const
export type LinkTab = (typeof LINK_TABS)[number]
export const LINK_TAB_LABELS: Record<LinkTab, string> = { all: "All", active: "On", inactive: "Off" }

export const CHECKOUT_TABS = ["received", "pending", "expired", "all"] as const
export type CheckoutTab = (typeof CHECKOUT_TABS)[number]
export const CHECKOUT_TAB_LABELS: Record<CheckoutTab, string> = {
  received: "Received",
  pending: "Waiting",
  expired: "Expired",
  all: "All",
}

export const CHECKOUT_STATUS_LABELS: Record<CheckoutStatus, string> = {
  pending: "Waiting",
  expired: "Expired",
  paid: "Paid",
  underpaid: "Part paid",
}

export const UNAVAILABLE_LABELS: Record<PaymentLinkUnavailableReason, string> = {
  taken_down: "Paused by LinkPay",
  inactive: "Turned off",
  expired: "Ended",
  sold_out: "Limit reached",
  account_not_ready: "Account not ready",
}

export const PHONE_LABELS: Record<PhoneFieldMode, string> = { off: "Don't ask", optional: "Optional", required: "Required" }

export const MATCHED_BY_LABELS: Record<NonNullable<LinkCheckout["matchedBy"]>, string> = {
  amount: "Matched on the exact amount",
  reference: "Matched on the reference in the narration",
  manual: "Linked by hand",
  simulated: "Simulated payment (test mode)",
}

export const PAGE_SIZES = [10, 20, 50, 100] as const
export const DEFAULT_PAGE_SIZE = 20

/** The same limits as backend/src/config/paymentLinks.ts. */
export const LIMITS = {
  minAmountKobo: 100_00,
  maxAmountKobo: 100_000_000_00,
  maxCustomFields: 5,
  maxAllowedOrigins: 10,
  maxImages: 4,
  maxImageBytes: 5 * 1024 * 1024,
} as const

/** Navy, as on the pay page before a business picks an accent. */
export const FALLBACK_PALETTE: BrandPalette = { accent: "#27394d", onAccent: "#ffffff", accentText: "#27394d" }

/** The types the backend takes. Anything else the browser can open (HEIC on Safari) is converted to JPEG first. */
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"]

const versionOf = (url: string) => new URL(url, "http://x").searchParams.get("v")

/** A link's picture in the dashboard (through the signed-in file proxy). */
export function linkImageSrc(image: Pick<PaymentLinkImage, "_id" | "url">) {
  const v = versionOf(image.url)
  return `/api/files/payment-link-images/${encodeURIComponent(image._id)}${v ? `?v=${encodeURIComponent(v)}` : ""}`
}

/** A link's picture on its public page and in embeds (no sign-in). */
export function publicLinkImageSrc(slug: string, image: Pick<PaymentLinkImage, "_id" | "url">) {
  const v = versionOf(image.url)
  return `/pay/${encodeURIComponent(slug)}/images/${encodeURIComponent(image._id)}${v ? `?v=${encodeURIComponent(v)}` : ""}`
}

type RawParams = Record<string, string | string[] | undefined>
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)
const pick = <T extends string>(list: readonly T[], value: string | undefined, fallback: T) =>
  (list as readonly string[]).includes(value ?? "") ? (value as T) : fallback
const page = (v: string | undefined) => Math.max(1, Math.trunc(Number(v)) || 1)
const size = (v: string | undefined) => {
  const n = Number(v)
  return (PAGE_SIZES as readonly number[]).includes(n) ? n : DEFAULT_PAGE_SIZE
}
const idOrUndefined = (v: string | undefined) => (v && /^[a-f\d]{24}$/i.test(v) ? v : undefined)

export type LinksQuery = {
  view: "links" | "payments"
  status: LinkTab
  /** The payments view's tab. */
  checkouts: CheckoutTab
  q?: string
  page: number
  size: number
  checkout?: string
}

export function parseLinksQuery(params: RawParams): LinksQuery {
  return {
    view: one(params.view) === "payments" ? "payments" : "links",
    status: pick(LINK_TABS, one(params.status), "all"),
    checkouts: pick(CHECKOUT_TABS, one(params.checkouts), "received"),
    q: one(params.q)?.trim().slice(0, 100) || undefined,
    page: page(one(params.page)),
    size: size(one(params.size)),
    checkout: idOrUndefined(one(params.checkout)),
  }
}

export type CheckoutQuery = {
  status: CheckoutTab
  source?: "page" | "embed"
  q?: string
  page: number
  size: number
  checkout?: string
  /** A link's own page while it's in test mode: its test payments or its real ones. */
  mode?: "live" | "test"
}

export function parseCheckoutQuery(params: RawParams): CheckoutQuery {
  const source = one(params.source)
  return {
    status: pick(CHECKOUT_TABS, one(params.status), "received"),
    source: source === "page" || source === "embed" ? source : undefined,
    q: one(params.q)?.trim().slice(0, 100) || undefined,
    page: page(one(params.page)),
    size: size(one(params.size)),
    checkout: idOrUndefined(one(params.checkout)),
    mode: one(params.mode) === "live" ? "live" : one(params.mode) === "test" ? "test" : undefined,
  }
}

/** Query string for GET /api/payment-links. */
export function linksApiParams(q: LinksQuery, branchId?: string) {
  const params = new URLSearchParams({ skip: String((q.page - 1) * q.size), take: String(q.size), status: q.status })
  if (branchId) params.set("branch", branchId)
  if (q.q) params.set("q", q.q)
  return params
}

/**
 * Query string for GET /api/payment-links/checkouts. Across every link only live payments show, like the
 * totals; a link's own page shows its test payments too, tagged.
 */
export function checkoutsApiParams(
  q: { status: CheckoutTab; source?: string; q?: string; page: number; size: number; mode?: "live" | "test" },
  scope: { link?: string; branch?: string },
) {
  const params = new URLSearchParams({ skip: String((q.page - 1) * q.size), take: String(q.size), status: q.status })
  if (scope.link) {
    params.set("link", scope.link)
    if (q.mode) params.set("mode", q.mode)
  } else params.set("mode", "live")
  if (scope.branch) params.set("branch", scope.branch)
  if (q.source) params.set("source", q.source)
  if (q.q) params.set("q", q.q)
  return params
}

/** "₦25,000", "Any amount", "From ₦1,000". */
export function priceLabel(link: Pick<PaymentLink, "amountKobo" | "minAmountKobo"> & Partial<Pick<PaymentLink, "kind" | "donation">>) {
  if (link.kind === "donation") return link.donation?.goalKobo ? `Goal ${formatNaira(link.donation.goalKobo)}` : "Donations"
  if (link.amountKobo) return formatNaira(link.amountKobo)
  return link.minAmountKobo ? `From ${formatNaira(link.minAmountKobo)}` : "Any amount"
}

/** What a link's tag says: "On", or why it isn't taking payments. */
export const linkStateLabel = (link: Pick<PaymentLink, "available" | "unavailableReason">) =>
  link.available ? "On" : UNAVAILABLE_LABELS[link.unavailableReason ?? "inactive"]

/** "3 of 50 paid" for a limited link, otherwise "3 payments" ("3 donations" on a donation link). */
export function paymentsLabel(link: Pick<PaymentLink, "paymentsCount" | "maxPayments"> & Partial<Pick<PaymentLink, "kind">>) {
  if (link.kind === "donation") return link.paymentsCount === 1 ? "1 donation" : `${link.paymentsCount} donations`
  if (link.maxPayments) return `${link.paymentsCount} of ${link.maxPayments} paid`
  return link.paymentsCount === 1 ? "1 payment" : `${link.paymentsCount} payments`
}

/** The extra kobo that makes the amount unique: "₦25,000.37" is the price plus 37 kobo. */
export const uniqueKobo = (c: Pick<LinkCheckout, "amountKobo" | "priceKobo">) => c.amountKobo - c.priceKobo

// ---------------------------------------------------------------------------------------------------------
// Allowed websites. Mirrors normalizeOrigin() in backend/src/services/paymentLinks.ts so the form can say
// what will be saved; the backend's answer is the one that counts.
// ---------------------------------------------------------------------------------------------------------

const isLocalHost = (h: string) => h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h.endsWith(".localhost")

export function normalizeOrigin(input: string): string | null {
  let s = input.trim().toLowerCase()
  if (!s) return null
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = `https://${s}`
  const wildcard = /^https?:\/\/\*\./.test(s)
  const PROBE = "wildcard-probe."
  let url: URL
  try {
    url = new URL(wildcard ? s.replace("*.", PROBE) : s)
  } catch {
    return null
  }
  if (url.username || url.password || url.hostname.includes("*")) return null
  const local = isLocalHost(url.hostname)
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null
  if (!local && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(url.hostname)) return null
  if (wildcard) {
    const rest = url.host.slice(PROBE.length)
    const host = rest.split(":")[0]!
    if (host.split(".").length < 2 || /^(com|org|gov|edu|net)\.[a-z]{2}$/.test(host)) return null
    return `${url.protocol}//*.${rest}`
  }
  return `${url.protocol}//${url.host}`
}

/** "https://shop.adaeze.ng" -> "shop.adaeze.ng", for display. */
export const originLabel = (origin: string) => origin.replace(/^https:\/\//, "")

// ---------------------------------------------------------------------------------------------------------
// Dates and times
// ---------------------------------------------------------------------------------------------------------

const lagosDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos", year: "numeric", month: "2-digit", day: "2-digit" })

/** "YYYY-MM-DD" in Lagos, for date inputs. */
export const lagosDate = (iso: string) => lagosDay.format(new Date(iso))

/** An end date picked as a day ends at the end of that day in Lagos. */
export const endOfLagosDay = (day: string) => new Date(`${day}T23:59:59+01:00`).toISOString()

/** "12:04" left, counting down; "0:00" once it's passed. */
export function countdown(expiresAt: string, now = Date.now()) {
  const left = Math.max(0, Math.floor((Date.parse(expiresAt) - now) / 1000))
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`
}

