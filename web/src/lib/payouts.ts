import type { Beneficiary } from "@/lib/api/types"
import { formatNaira } from "@/lib/format"
import { MAX_TRANSFER_KOBO, parseNairaToKobo } from "@/lib/transfers"

/**
 * Saved beneficiaries and payout lists (docs/briefs/bulk-payouts.md). Shared by the server pages and the client
 * views. The Beneficiaries page keeps its state in the URL (?q=&page=&size=), like Transfers.
 */

/** Rows in one payout list, as in one bulk transfer. */
export const MAX_LIST_ROWS = 200
export const MAX_LIST_TITLE = 80
export const MAX_NICKNAME = 60
export const MAX_NARRATION = 100

export const PAGE_SIZES = [10, 20, 50, 100] as const
export const DEFAULT_PAGE_SIZE = 20

export type BeneficiaryQuery = { q?: string; page: number; size: number }

type RawParams = Record<string, string | string[] | undefined>
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

export function parseBeneficiaryQuery(params: RawParams): BeneficiaryQuery {
  const size = Number(one(params.size))
  return {
    q: one(params.q)?.trim().slice(0, 100) || undefined,
    page: Math.max(1, Math.trunc(Number(one(params.page))) || 1),
    size: (PAGE_SIZES as readonly number[]).includes(size) ? size : DEFAULT_PAGE_SIZE,
  }
}

/** Query string for GET /api/beneficiaries. */
export function beneficiaryApiParams(q: BeneficiaryQuery) {
  const params = new URLSearchParams({ skip: String((q.page - 1) * q.size), take: String(q.size) })
  if (q.q) params.set("q", q.q)
  return params
}

/** "1 person", "4 people". */
export const people = (n: number) => `${n} ${n === 1 ? "person" : "people"}`

/** The bank's name for the account, and the nickname when it has one. */
export type BeneficiaryLike = Pick<Beneficiary, "_id" | "accountName" | "nickname" | "accountNumber" | "bankName">

/** What's wrong with an amount typed for a list row, if anything. */
export function amountProblem(text: string) {
  const kobo = parseNairaToKobo(text)
  if (kobo === null || kobo < 100) return "Enter at least ₦1."
  if (kobo > MAX_TRANSFER_KOBO) return `One transfer can be at most ${formatNaira(MAX_TRANSFER_KOBO)}.`
  return undefined
}
