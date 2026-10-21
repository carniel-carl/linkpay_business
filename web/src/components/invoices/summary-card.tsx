import type { InvoiceSummary } from "@/lib/api/types"
import { formatNaira } from "@/lib/format"

/** What customers owe, with the overdue part and what's come in this month beside it. */
export function InvoiceSummaryCard({ summary }: { summary: InvoiceSummary | null }) {
  return (
    <section aria-label="Invoice totals" className="surface grid gap-6 p-6 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end sm:p-8">
      <div className="grid gap-1.5">
        <p className="text-sm text-muted-foreground">Owed to you</p>
        {summary ? (
          <>
            <p className="type-display text-[2.5rem] break-all sm:text-5xl figure">{formatNaira(summary.outstandingKobo)}</p>
            <p className="text-sm text-muted-foreground">
              {summary.unpaidCount === 1 ? "1 unpaid invoice" : `${summary.unpaidCount} unpaid invoices`}
            </p>
          </>
        ) : (
          <p className="type-display text-3xl text-muted-foreground">Unavailable</p>
        )}
      </div>
      {summary && (
        <dl className="flex flex-wrap gap-x-8 gap-y-3 text-sm sm:justify-end">
          <div className="grid gap-0.5">
            <dt className="text-xs text-muted-foreground">Overdue</dt>
            <dd className={summary.overdueCount > 0 ? "font-medium text-destructive figure" : "font-medium figure"}>
              {formatNaira(summary.overdueKobo)}
              <span className="ml-1.5 text-xs font-normal text-muted-foreground">({summary.overdueCount})</span>
            </dd>
          </div>
          <div className="grid gap-0.5">
            <dt className="text-xs text-muted-foreground">Paid this month</dt>
            <dd className="font-medium figure">{formatNaira(summary.collectedThisMonthKobo)}</dd>
          </div>
          {summary.counts.draft > 0 && (
            <div className="grid gap-0.5">
              <dt className="text-xs text-muted-foreground">Drafts</dt>
              <dd className="font-medium figure">{summary.counts.draft}</dd>
            </div>
          )}
        </dl>
      )}
    </section>
  )
}
