import Link from "next/link"
import { BatchDecisionButtons, levelText } from "@/components/transfers/batch-decision"
import type { TransferBatchList } from "@/lib/api/types"
import { formatNaira, formatShortDate } from "@/lib/format"

/**
 * Bulk transfers with rows waiting for the member (GET /api/transfers/batches?awaiting=me), each with where its
 * waiting rows are ("Level 1 of 2 · 3 waiting for you") and approve or reject for the member's rows.
 */
export function WaitingBatches({ data, showBranch }: { data: TransferBatchList; showBranch: boolean }) {
  if (!data.items.length) return null
  return (
    <section className="surface overflow-hidden" aria-labelledby="waiting-batches-title">
      <div className="grid gap-1 px-5 pt-5 pb-4 sm:px-6">
        <h2 id="waiting-batches-title" className="font-medium">
          Bulk transfers waiting for you
        </h2>
        <p className="text-sm text-muted-foreground">
          Approve or reject the transfers waiting for you in one go. Any at another level stay for their approvers.
          {data.total > data.items.length && ` Showing the newest ${data.items.length} of ${data.total}.`}
        </p>
      </div>
      <ul className="divide-y border-t">
        {data.items.map((b) => (
          <li key={b._id} className="grid gap-3 px-5 py-4 sm:px-6 lg:grid-cols-[1fr_auto] lg:items-center">
            <div className="flex min-w-0 items-start justify-between gap-4">
              <div className="grid min-w-0 gap-0.5">
                <Link href={`/transfers?batch=${b._id}`} className="w-fit truncate font-medium hover:underline focus-visible:underline focus-visible:outline-none">
                  {b.title ?? "Bulk transfer"}
                </Link>
                <p className="text-xs text-muted-foreground">
                  {b.count} transfers
                  {b.createdBy && `, prepared by ${b.createdBy.name}`}
                  {showBranch && b.branch && ` · ${b.branch.name}`}
                  {` · ${formatShortDate(b.createdAt)}`}
                </p>
                <ul className="mt-1 grid gap-0.5 text-sm">
                  {b.levels.map((l) => (
                    <li key={`${l.level}/${l.of}`} className={l.awaitingMe ? undefined : "text-muted-foreground"}>
                      {levelText(l)}
                    </li>
                  ))}
                </ul>
              </div>
              <p className="shrink-0 font-medium figure">{formatNaira(b.amountKobo)}</p>
            </div>
            <div className="flex flex-wrap gap-2 lg:justify-end">
              <BatchDecisionButtons batchId={b._id} awaitingMe={b.awaitingMe} size="sm" />
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
