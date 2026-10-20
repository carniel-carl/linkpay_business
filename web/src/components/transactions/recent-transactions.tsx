"use client"

import { useState } from "react"
import Link from "next/link"
import { ArrowRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { Transaction } from "@/lib/api/types"
import { formatNaira, formatShortDate, formatTime } from "@/lib/format"
import { Amount, DirectionIcon, payerName, TransactionStatusBadge } from "./parts"
import { TransactionSheet } from "./transaction-sheet"

/** Home: the latest few payments, this month's money in, and a way to the full list. */
export function RecentTransactions({
  items,
  moneyInKobo,
  showBranch,
}: {
  items: Transaction[]
  /** Successful money in this month, or null if the total couldn't load. */
  moneyInKobo: number | null
  showBranch: boolean
}) {
  const [open, setOpen] = useState<Transaction | null>(null)

  return (
    <section aria-labelledby="transactions-title" className="surface overflow-hidden">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 border-b px-6 py-5 sm:px-8">
        <div className="grid gap-1">
          <h2 id="transactions-title" className="font-display text-lg font-semibold tracking-[-0.02em]">
            Recent transactions
          </h2>
          {moneyInKobo !== null && (
            <p className="text-sm text-muted-foreground">
              Money in this month <span className="font-medium text-foreground figure">{formatNaira(moneyInKobo)}</span>
            </p>
          )}
        </div>
        <Button variant="ghost" size="sm" className="-mr-3" asChild>
          <Link href="/transactions">
            View all
            <ArrowRight data-icon="inline-end" aria-hidden />
          </Link>
        </Button>
      </div>
      <ul className="divide-y">
        {items.map((tx) => (
          <li key={tx._id}>
            <button
              type="button"
              onClick={() => setOpen(tx)}
              className="flex w-full items-center gap-3.5 px-6 py-3.5 text-left transition-colors duration-150 hover:bg-muted/50 focus-visible:bg-muted/60 focus-visible:outline-none sm:px-8"
            >
              <DirectionIcon tx={tx} />
              <span className="grid min-w-0 flex-1 gap-0.5">
                <span className="truncate font-medium">{payerName(tx)}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {formatShortDate(tx.occurredAt)}, {formatTime(tx.occurredAt)}
                  {tx.narration && <span className="hidden sm:inline"> · {tx.narration}</span>}
                  {showBranch && tx.branch && ` · ${tx.branch.name}`}
                </span>
              </span>
              <span className="grid justify-items-end gap-1">
                <Amount tx={tx} />
                {tx.status !== "success" && <TransactionStatusBadge status={tx.status} />}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <TransactionSheet tx={open} onClose={() => setOpen(null)} />
    </section>
  )
}
