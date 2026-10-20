import type { AccountSetupStatus } from "@/lib/api/types"
import type { BusinessStatus } from "@/lib/kyb"

/**
 * The staff businesses table keeps its state in the URL (?status=&q=&sort=&dir=&page=&size=), so
 * views can be bookmarked and shared and the back button works. Shared by server pages and the
 * client table.
 */

export const ADMIN_SORTS = ["submitted", "created", "name"] as const
export type AdminSort = (typeof ADMIN_SORTS)[number]
export const PAGE_SIZES = [10, 20, 50, 100] as const
const ACCOUNT_STATUSES: AccountSetupStatus[] = ["not_started", "pending", "active", "failed"]

export const STATUS_FILTERS: (BusinessStatus | "all")[] = [
  "all",
  "submitted",
  "changes_requested",
  "approved",
  "rejected",
  "draft",
]

// Staff see the raw workflow states; owners see the friendlier STATUS_LABELS.
export const STATUS_FILTER_LABELS: Record<BusinessStatus | "all", string> = {
  all: "All",
  submitted: "Submitted",
  changes_requested: "Changes requested",
  approved: "Approved",
  rejected: "Rejected",
  draft: "Draft",
}

export type AdminListQuery = {
  status?: BusinessStatus
  account?: AccountSetupStatus
  q?: string
  sort: AdminSort
  dir: "asc" | "desc"
  page: number
  size: number
}

type RawParams = Record<string, string | string[] | undefined>
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

export function parseAdminQuery(
  params: RawParams,
  defaults: { status?: BusinessStatus; sort?: AdminSort; dir?: "asc" | "desc" } = {},
): AdminListQuery {
  const status = one(params.status)
  const account = one(params.account)
  const sort = one(params.sort)
  const dir = one(params.dir)
  const size = Number(one(params.size))
  return {
    status: status === "all" ? undefined : (STATUS_FILTERS as string[]).includes(status ?? "") ? (status as BusinessStatus) : defaults.status,
    account: (ACCOUNT_STATUSES as string[]).includes(account ?? "") ? (account as AccountSetupStatus) : undefined,
    q: one(params.q)?.trim().slice(0, 100) || undefined,
    sort: (ADMIN_SORTS as readonly string[]).includes(sort ?? "") ? (sort as AdminSort) : (defaults.sort ?? "submitted"),
    dir: dir === "asc" || dir === "desc" ? dir : (defaults.dir ?? "asc"),
    page: Math.max(1, Math.trunc(Number(one(params.page))) || 1),
    size: (PAGE_SIZES as readonly number[]).includes(size) ? size : 20,
  }
}

export function toApiParams(query: AdminListQuery) {
  const q = new URLSearchParams({
    sort: query.sort,
    dir: query.dir,
    skip: String((query.page - 1) * query.size),
    take: String(query.size),
  })
  if (query.status) q.set("status", query.status)
  if (query.account) q.set("account", query.account)
  if (query.q) q.set("q", query.q)
  return q
}
