import Link from "next/link"
import { ListChecks, Plus } from "lucide-react"
import { WriteGate } from "@/components/shell/write-gate"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import type { PayoutList } from "@/lib/api/types"
import { formatDate, formatNaira } from "@/lib/format"
import { people } from "@/lib/payouts"
import { cn } from "@/lib/utils"
import { PayoutListMenu } from "./payout-list-actions"

/** The most lists a business can save (PAYOUT_LIST_LIMIT). */
const MAX_LISTS = 100

type Props = {
  lists: PayoutList[]
  /** Every list the member can see, before the branch switcher narrowed them. */
  total: number
  canManage: boolean
  showBranch: boolean
  /** The branch the sidebar switcher is showing, when it narrowed the lists. */
  branchName?: string
}

/** Payout lists as cards: title, default account, people, total before fees, last run, and Pay now. */
export function PayoutListsView({ lists, total, canManage, showBranch, branchName }: Props) {
  if (total === 0) {
    return (
      <Empty className="surface min-h-96 border-0 p-10">
        <EmptyHeader>
          <EmptyMedia variant="icon" className="bg-pop-subtle text-foreground">
            <ListChecks aria-hidden />
          </EmptyMedia>
          <EmptyTitle className="type-display text-2xl">Pay the same people again in a few clicks</EmptyTitle>
          <EmptyDescription>
            Save the people you pay often, like monthly salaries or regular suppliers, with what each one gets. Then pay the whole list at once, changing
            amounts when you need to.
          </EmptyDescription>
        </EmptyHeader>
        {canManage && (
          <EmptyContent className="gap-3">
            <WriteGate>
              <Button asChild>
                <Link href="/payout-lists/new">
                  <Plus data-icon="inline-start" aria-hidden />
                  New payout list
                </Link>
              </Button>
            </WriteGate>
            <p className="text-xs text-muted-foreground">You can also save a past bulk transfer as a list from its page in Transfers.</p>
          </EmptyContent>
        )}
      </Empty>
    )
  }

  return (
    <div className="grid gap-4">
      {branchName && lists.length < total && (
        <p className="text-sm text-muted-foreground">
          Showing lists that pay from {branchName}, and lists with no default account. Choose “All branches” in the sidebar to see all {total}.
        </p>
      )}
      <ul className="stagger grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
        {lists.map((l, i) => (
          <li key={l._id} style={{ "--i": i } as React.CSSProperties}>
            <ListCard list={l} canManage={canManage} showBranch={showBranch} />
          </li>
        ))}
        {canManage && total < MAX_LISTS && (
          <li style={{ "--i": lists.length } as React.CSSProperties}>
            <WriteGate block>
              <Link
                href="/payout-lists/new"
                className={cn(
                  "grid h-full min-h-56 w-full place-content-center justify-items-center gap-3 rounded-2xl border-2 border-dashed p-6 text-sm text-muted-foreground",
                  "transition-colors duration-200 hover:border-primary/40 hover:text-foreground",
                  "focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                )}
              >
                <span className="grid size-10 place-items-center rounded-[12px] bg-muted">
                  <Plus className="size-5" aria-hidden />
                </span>
                New payout list
              </Link>
            </WriteGate>
          </li>
        )}
      </ul>
    </div>
  )
}

function ListCard({ list: l, canManage, showBranch }: { list: PayoutList; canManage: boolean; showBranch: boolean }) {
  // The last run: a bulk transfer, or one plain transfer when it paid a single person.
  const lastHref = l.lastBatch ? `/transfers?batch=${l.lastBatch}` : l.lastTransfer ? `/transfers?transfer=${l.lastTransfer}` : null
  return (
    <article
      className={cn(
        "surface relative grid h-full content-between gap-6 p-6 transition-[box-shadow,transform] duration-200",
        "hover:-translate-y-0.5 has-[a[data-card]:focus-visible]:ring-3 has-[a[data-card]:focus-visible]:ring-ring/50 motion-reduce:hover:translate-y-0",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3.5">
          <span className="grid size-10 shrink-0 place-items-center rounded-[12px] bg-brand-subtle text-primary" aria-hidden>
            <ListChecks className="size-5" />
          </span>
          <div className="grid min-w-0 gap-1">
            <h3 className="font-display text-lg leading-tight font-semibold tracking-[-0.02em]">
              <Link data-card href={`/payout-lists/${l._id}`} className="outline-none after:absolute after:inset-0 after:rounded-[inherit]">
                {l.title}
              </Link>
            </h3>
            <p className="truncate text-xs text-muted-foreground">
              {l.branch ? `Pays from ${l.branch.name}` : showBranch ? "No default account" : "Choose the account when you pay"}
            </p>
          </div>
        </div>
        {canManage && (
          // The menu opens either way; its items are dimmed while suspended (`write`).
          <div className="relative z-10">
            <PayoutListMenu list={l} />
          </div>
        )}
      </div>

      <div className="grid gap-1">
        <p className="type-display text-3xl figure">{formatNaira(l.amountKobo)}</p>
        <p className="text-xs text-muted-foreground">{people(l.count)}, before fees</p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4 text-sm">
        <span className="text-muted-foreground">
          {l.lastRunAt ? (
            lastHref ? (
              <Link
                href={lastHref}
                className="relative z-10 underline-offset-4 hover:text-foreground hover:underline focus-visible:underline focus-visible:outline-none"
              >
                Last paid {formatDate(l.lastRunAt)}
              </Link>
            ) : (
              <>Last paid {formatDate(l.lastRunAt)}</>
            )
          ) : (
            "Not paid yet"
          )}
        </span>
        {canManage && (
          // Disabled, with the reason, while the business is suspended. Above the card's own link either way.
          <WriteGate className="relative z-10">
            <Button size="sm" asChild className="relative z-10">
              <Link href={`/payout-lists/${l._id}#pay`}>Pay now</Link>
            </Button>
          </WriteGate>
        )}
      </div>
    </article>
  )
}
