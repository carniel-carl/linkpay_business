"use client"

import Link from "next/link"
import { ArrowRight } from "lucide-react"
import { CopyButton } from "@/components/accounts/copy-button"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import type { Transaction } from "@/lib/api/types"
import { formatDateTime, formatNaira } from "@/lib/format"
import { Amount, DirectionIcon, payerName, TransactionStatusBadge } from "./parts"

/** Everything we know about one transaction. The list already carries every field, so nothing is fetched. */
export function TransactionSheet({ tx, onClose }: { tx: Transaction | null; onClose: () => void }) {
  return (
    <Sheet open={!!tx} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="gap-0 overflow-y-auto p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-md">
        {tx && <Details tx={tx} />}
      </SheetContent>
    </Sheet>
  )
}

function Details({ tx }: { tx: Transaction }) {
  const credit = tx.direction === "credit"
  const name = payerName(tx)

  return (
    <>
      <SheetHeader className="gap-5 border-b bg-muted/50 p-6 pr-14">
        <div className="flex items-center gap-3">
          <DirectionIcon tx={tx} />
          <TransactionStatusBadge status={tx.status} />
        </div>
        <div className="grid gap-1.5">
          <SheetTitle className="type-display text-4xl font-normal">
            <Amount tx={tx} className="font-[inherit]" />
          </SheetTitle>
          <SheetDescription>
            {credit ? "From" : "To"} <span className="font-medium text-foreground">{name}</span>, {formatDateTime(tx.occurredAt)}
          </SheetDescription>
        </div>
        {tx.transfer && (
          <Button variant="outline" size="sm" className="w-fit" asChild>
            <Link href={`/transfers?transfer=${encodeURIComponent(tx.transfer)}`}>
              View transfer
              <ArrowRight data-icon="inline-end" aria-hidden />
            </Link>
          </Button>
        )}
      </SheetHeader>

      <div className="grid gap-7 p-6">
        <Group title="Amount">
          <Row label={credit ? "Amount paid" : "Amount sent"} value={<span className="figure">{formatNaira(tx.amountKobo)}</span>} />
          <Row label="Fee" value={<span className="figure">{formatNaira(tx.feeKobo)}</span>} />
          <Row
            // For money out, netKobo is everything that left the account (amount + fee).
            label={credit ? (tx.status === "success" ? "You received" : "Net amount") : "Total debited"}
            value={<span className="figure font-semibold">{formatNaira(tx.netKobo)}</span>}
          />
        </Group>

        <Group title={credit ? "Payer" : "Recipient"}>
          <Row label="Name" value={name} />
          <Row label="Bank" value={tx.counterparty.bankName} />
          <Row
            label="Account number"
            value={tx.counterparty.accountNumber && <span className="font-mono tracking-[0.04em]">{tx.counterparty.accountNumber}</span>}
          />
        </Group>

        <Group title="Details">
          <Row
            label="Reference"
            value={
              tx.reference && (
                <span className="flex min-w-0 items-center justify-end gap-0.5">
                  <span className="truncate font-mono text-xs">{tx.reference}</span>
                  <CopyButton value={tx.reference} message="Reference copied" label="Copy reference" />
                </span>
              )
            }
          />
          <Row label="Narration" value={tx.narration} />
          <Row label="Time" value={formatDateTime(tx.occurredAt)} />
          <Row label="Status" value={<TransactionStatusBadge status={tx.status} />} />
        </Group>

        <Group title={credit ? "Arrived in" : "Sent from"}>
          <Row
            label="Account"
            value={
              tx.account && (
                <span className="grid justify-items-end">
                  <span>{tx.account.label}</span>
                  <span className="text-xs text-muted-foreground">
                    {tx.account.bankName && `${tx.account.bankName} · `}
                    <span className="font-mono tracking-[0.04em]">{tx.account.accountNumber}</span>
                  </span>
                </span>
              )
            }
          />
          <Row label="Branch" value={tx.branch?.name} />
        </Group>
      </div>
    </>
  )
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-2">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      <dl className="divide-y rounded-xl border">{children}</dl>
    </section>
  )
}

function Row({ label, value }: { label: string; value?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-6 px-4 py-3 text-sm">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right break-words">{value || <span className="text-muted-foreground">Not given</span>}</dd>
    </div>
  )
}
