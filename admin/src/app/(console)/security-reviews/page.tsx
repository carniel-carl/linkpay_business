import type { Metadata } from "next"
import Link from "next/link"
import { ChevronRight } from "lucide-react"
import { PageHeader } from "@/components/common/page-header"
import { Pager } from "@/components/common/url-state"
import { RequestStatusBadge, RiskBadge } from "@/components/security/security-parts"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import type { SecurityRequest, SecurityRequestStatus, SecuritySummary } from "@/lib/api/types"
import { one } from "@/lib/compliance"
import { getSecurityRequests, getSecuritySummary } from "@/lib/data"
import { formatDateTime, timeAgo } from "@/lib/format"
import { requirePermission } from "@/lib/guard"
import { describeRequest } from "@/lib/security"
import { cn } from "@/lib/utils"

export const metadata: Metadata = { title: "Security reviews" }

const PAGE_SIZE = 25
const TABS: { status: SecurityRequestStatus; label: string }[] = [
  { status: "pending", label: "Waiting" },
  { status: "approved", label: "Cooling off" },
  { status: "completed", label: "In effect" },
  { status: "rejected", label: "Rejected" },
  { status: "cancelled", label: "Cancelled" },
]

export default async function SecurityReviewsPage({ searchParams }: PageProps<"/security-reviews">) {
  const blocked = await requirePermission("security.review", "Security reviews")
  if (blocked) return blocked
  const raw = await searchParams
  const status = TABS.find((t) => t.status === one(raw.status))?.status ?? "pending"
  const page = Math.max(1, Math.trunc(Number(one(raw.page))) || 1)
  const [summary, list] = await Promise.all([getSecuritySummary(), getSecurityRequests(status, page, PAGE_SIZE)])

  return (
    <>
      <PageHeader
        title="Security reviews"
        description="New settlement accounts and requests to loosen money-out protection. Call the business back on a number from its verification before approving."
      />
      <div className="stagger grid gap-6">
        <div style={{ "--i": 0 } as React.CSSProperties}>
          <Tiles summary={summary} />
        </div>
        <section style={{ "--i": 1 } as React.CSSProperties} aria-labelledby="requests-title" className="surface min-w-0 overflow-hidden">
          <h2 id="requests-title" className="sr-only">
            Requests
          </h2>
          <nav aria-label="Filter by status" className="overflow-x-auto border-b px-4 sm:px-6">
            <ul className="flex w-max min-w-full gap-1">
              {TABS.map((t) => {
                const active = t.status === status
                return (
                  <li key={t.status}>
                    <Link
                      href={t.status === "pending" ? "/security-reviews" : `/security-reviews?status=${t.status}`}
                      scroll={false}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "-mb-px inline-flex h-12 items-center gap-2 border-b-2 px-3 text-sm whitespace-nowrap transition-colors duration-150",
                        "rounded-t-md focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                        active ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {t.label}
                      {(t.status === "pending" || t.status === "approved") && (
                        <span className={cn("figure rounded-md px-1.5 py-px text-xs", active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}>
                          {t.status === "pending" ? summary.pending : summary.coolingOff}
                        </span>
                      )}
                    </Link>
                  </li>
                )
              })}
            </ul>
          </nav>
          {list.items.length === 0 ? (
            <Empty className="min-h-64 border-0 p-10">
              <EmptyHeader>
                <EmptyTitle>{status === "pending" ? "Nothing waiting" : "Nothing here yet"}</EmptyTitle>
                <EmptyDescription>
                  {status === "pending"
                    ? "New settlement accounts and requests to turn off \"settlement accounts only\" show here, oldest first."
                    : "Requests show here once they reach this state."}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ul className="divide-y">
              {list.items.map((r) => (
                <RequestRow key={r._id} request={r} />
              ))}
            </ul>
          )}
          <Pager total={list.total} page={page} pageSize={PAGE_SIZE} noun="requests" />
        </section>
      </div>
    </>
  )
}

function RequestRow({ request: r }: { request: SecurityRequest }) {
  return (
    <li>
      <Link
        href={`/security-reviews/${r._id}`}
        className="group flex items-center gap-4 px-4 py-4 transition-colors duration-150 outline-none hover:bg-muted/50 focus-visible:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset sm:px-6"
      >
        <div className="grid min-w-0 flex-1 gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{r.business?.name ?? "Unknown business"}</span>
            <RiskBadge risk={r.signals.risk} />
            {r.status !== "pending" && <RequestStatusBadge status={r.status} />}
            {r.business?.frozen && <span className="text-xs text-destructive">Money out frozen</span>}
          </div>
          <p className="truncate text-sm text-muted-foreground">{describeRequest(r)}</p>
          <p className="text-xs text-muted-foreground">
            Asked by {r.requestedBy?.name ?? "someone"} <time dateTime={r.createdAt} title={formatDateTime(r.createdAt)}>{timeAgo(r.createdAt)}</time>. Cooling-off ends{" "}
            {formatDateTime(r.availableAt)}.
          </p>
        </div>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform duration-150 group-hover:translate-x-0.5" aria-hidden />
      </Link>
    </li>
  )
}

function Tiles({ summary }: { summary: SecuritySummary }) {
  const tiles = [
    { label: "Waiting for review", value: summary.pending, detail: "Oldest first", alert: summary.pending > 0 },
    { label: "Cooling off", value: summary.coolingOff, detail: "Approved, not yet in effect" },
    { label: "Money out frozen", value: summary.frozen, detail: "Businesses", alert: summary.frozen > 0 },
    { label: "\"This wasn't me\" reports", value: summary.reports30d, detail: "Last 30 days" },
  ]
  return (
    <ul aria-label="Summary" className="grid grid-cols-2 overflow-hidden surface lg:grid-cols-4">
      {tiles.map((t, i) => (
        <li key={t.label} className={cn("grid gap-2 border-border p-4 sm:p-6", i % 2 === 1 && "border-l", i > 1 && "border-t lg:border-t-0", i === 2 && "lg:border-l")}>
          <span className="text-sm text-muted-foreground">{t.label}</span>
          <span className={cn("type-display figure text-3xl sm:text-4xl", t.alert && "text-destructive")}>{t.value}</span>
          <span className="text-xs text-muted-foreground">{t.detail}</span>
        </li>
      ))}
    </ul>
  )
}
