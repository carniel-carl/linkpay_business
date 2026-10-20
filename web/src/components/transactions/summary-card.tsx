import type { TransactionSummary } from "@/lib/api/types"
import { formatNaira } from "@/lib/format"

/** Money in for the period (successful payments only), with money out and fees beside it. */
export function SummaryCard({ summary, period }: { summary: TransactionSummary | null; period: string }) {
  return (
    <section aria-label={`Totals, ${period}`} className="surface grid gap-6 p-6 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end sm:p-8">
      <div className="grid gap-1.5">
        <p className="text-sm text-muted-foreground">Money in, {period.toLowerCase()}</p>
        {summary ? (
          <p className="type-display text-[2.5rem] break-all sm:text-5xl figure">{formatNaira(summary.inflowKobo)}</p>
        ) : (
          <p className="type-display text-3xl text-muted-foreground">Unavailable</p>
        )}
      </div>
      {summary && (
        <dl className="flex flex-wrap gap-x-8 gap-y-3 text-sm sm:justify-end">
          <Stat label="Successful transactions" value={String(summary.count)} />
          <Stat label="Money out" value={formatNaira(summary.outflowKobo)} />
          {summary.feesKobo > 0 && <Stat label="Fees" value={formatNaira(summary.feesKobo)} />}
        </dl>
      )}
    </section>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium figure">{value}</dd>
    </div>
  )
}
