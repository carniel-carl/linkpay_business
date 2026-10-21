"use client"

import { useState } from "react"
import Link from "next/link"
import { ArrowDownLeft, ArrowUpRight, Building2, Hourglass, Inbox, SearchX } from "lucide-react"
import { RestrictionBadge } from "@/components/compliance/badges"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { AdminTransfer, FeedTransaction, Transaction, TransactionStatus, TransferStatus } from "@/lib/api/types"
import { TRANSACTION_STATUS_LABELS, TRANSFER_KIND_LABELS, TRANSFER_STATUS_LABELS } from "@/lib/compliance"
import { formatDate, formatNaira, formatTime } from "@/lib/format"
import { cn } from "@/lib/utils"

const TX_VARIANT: Record<TransactionStatus, "success" | "outline" | "destructive" | "muted"> = {
  success: "success",
  pending: "outline",
  failed: "destructive",
  reversed: "muted",
}

const TRANSFER_VARIANT: Record<TransferStatus, "success" | "outline" | "destructive" | "muted" | "warning"> = {
  success: "success",
  processing: "outline",
  pending_approval: "warning",
  failed: "destructive",
  rejected: "muted",
  cancelled: "muted",
}

const head = "h-10 text-xs font-medium text-muted-foreground"
const edge = "first:pl-4 last:pr-4 sm:first:pl-6 sm:last:pr-6"

type Selection = {
  /** Shown above the table while rows are ticked, e.g. a "Flag selected" button. */
  action: (ids: string[], clear: () => void) => React.ReactNode
}

function useSelection() {
  const [ids, setIds] = useState<string[]>([])
  const toggle = (id: string, on: boolean) => setIds((s) => (on ? [...s, id] : s.filter((x) => x !== id)))
  return { ids, toggle, setIds, clear: () => setIds([]) }
}

function SelectionBar({ count, children }: { count: number; children: React.ReactNode }) {
  if (!count) return null
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t bg-brand-subtle px-4 py-2.5 text-sm sm:px-6">
      <span className="figure">
        {count} selected
      </span>
      {children}
    </div>
  )
}

function When({ iso }: { iso: string }) {
  return (
    <div className="grid gap-0.5 whitespace-nowrap">
      <span className="figure">{formatDate(iso)}</span>
      <span className="text-xs text-muted-foreground figure">{formatTime(iso)}</span>
    </div>
  )
}

export function ListEmpty({ filtered, noun }: { filtered: boolean; noun: string }) {
  return (
    <Empty className="min-h-64 border-0">
      <EmptyHeader>
        <EmptyMedia variant="icon">{filtered ? <SearchX aria-hidden /> : <Inbox aria-hidden />}</EmptyMedia>
        <EmptyTitle>{filtered ? "No matches" : `No ${noun} yet`}</EmptyTitle>
        <EmptyDescription>
          {filtered ? "Nothing matches these filters. Widen the dates or clear a filter." : `When there are ${noun}, they show here, newest first.`}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}

// ---- Payments ----

type Payment = Transaction | FeedTransaction

/** Payments in and out, newest first. `showBusiness` adds the business column for the platform feed. */
export function PaymentsTable({
  items,
  caption,
  showBusiness = false,
  filtered,
  select,
  busy,
}: {
  items: Payment[]
  caption: string
  showBusiness?: boolean
  filtered: boolean
  select?: Selection
  busy?: boolean
}) {
  const selection = useSelection()
  const columns = 5 + (showBusiness ? 1 : 0) + (select ? 1 : 0)
  const allOnPage = items.length > 0 && items.every((t) => selection.ids.includes(t._id))

  return (
    <>
      {select && (
        <SelectionBar count={selection.ids.length}>{select.action(selection.ids, selection.clear)}</SelectionBar>
      )}
      <Table aria-busy={busy} className="min-w-200">
        <caption className="sr-only">{caption}</caption>
        <TableHeader className="bg-muted/60">
          <TableRow className="hover:bg-transparent">
            {select && (
              <TableHead scope="col" className={cn(head, edge, "w-10")}>
                <Checkbox
                  aria-label="Select every payment on this page"
                  checked={allOnPage}
                  onCheckedChange={(c) => selection.setIds(c ? items.map((t) => t._id) : [])}
                  disabled={!items.length}
                />
              </TableHead>
            )}
            <TableHead scope="col" className={cn(head, edge)}>When</TableHead>
            {showBusiness && <TableHead scope="col" className={head}>Business</TableHead>}
            <TableHead scope="col" className={head}>From or to</TableHead>
            <TableHead scope="col" className={head}>Account</TableHead>
            <TableHead scope="col" className={cn(head, "text-right")}>Amount</TableHead>
            <TableHead scope="col" className={cn(head, edge)}>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody className={cn("transition-opacity duration-150", busy && "opacity-60")}>
          {items.length === 0 ? (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={columns} className="p-0">
                <ListEmpty filtered={filtered} noun="payments" />
              </TableCell>
            </TableRow>
          ) : (
            items.map((t) => {
              const credit = t.direction === "credit"
              const business = "business" in t ? t.business : null
              return (
                <TableRow key={t._id}>
                  {select && (
                    <TableCell className={cn(edge, "py-3")}>
                      <Checkbox
                        aria-label={`Select payment of ${formatNaira(t.amountKobo)} on ${formatDate(t.occurredAt)}`}
                        checked={selection.ids.includes(t._id)}
                        onCheckedChange={(c) => selection.toggle(t._id, !!c)}
                      />
                    </TableCell>
                  )}
                  <TableCell className={cn(edge, "py-3")}>
                    <When iso={t.occurredAt} />
                  </TableCell>
                  {showBusiness && (
                    <TableCell className="py-3">
                      {business ? (
                        <div className="grid min-w-40 gap-1">
                          <Link
                            href={`/businesses/${business._id}/activity`}
                            className="inline-flex w-fit items-center gap-1.5 font-medium hover:underline focus-visible:underline focus-visible:outline-none"
                          >
                            {business.name}
                          </Link>
                          <span className="flex flex-wrap gap-1">
                            <RestrictionBadge status={business.compliance} />
                            {business.openFlags > 0 && (
                              <span className="text-xs text-muted-foreground figure">
                                {business.openFlags} open {business.openFlags === 1 ? "flag" : "flags"}
                              </span>
                            )}
                          </span>
                        </div>
                      ) : (
                        <span className="text-muted-foreground">Unknown</span>
                      )}
                    </TableCell>
                  )}
                  <TableCell className="py-3">
                    <div className="grid min-w-44 gap-0.5">
                      <span className="flex items-center gap-1.5 font-medium">
                        {credit ? (
                          <ArrowDownLeft className="size-3.5 shrink-0 text-success" aria-label="Money in" />
                        ) : (
                          <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground" aria-label="Money out" />
                        )}
                        {t.counterparty.name || "Unknown"}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {[t.counterparty.bankName, t.counterparty.accountNumber].filter(Boolean).join(", ") || "No bank details"}
                      </span>
                      {t.narration && <span className="max-w-64 truncate text-xs text-muted-foreground">{t.narration}</span>}
                    </div>
                  </TableCell>
                  <TableCell className="py-3">
                    <div className="grid gap-0.5">
                      <span>{t.branch?.name ?? t.account?.label ?? "Unknown"}</span>
                      {t.account && <span className="font-mono text-xs text-muted-foreground">{t.account.accountNumber}</span>}
                    </div>
                  </TableCell>
                  <TableCell className="py-3 text-right">
                    <span className={cn("figure font-medium whitespace-nowrap", credit && "text-success-foreground")}>
                      {credit ? "+" : "-"}
                      {formatNaira(t.amountKobo)}
                    </span>
                    {t.feeKobo > 0 && (
                      <div className="text-xs text-muted-foreground figure whitespace-nowrap">Fee {formatNaira(t.feeKobo)}</div>
                    )}
                  </TableCell>
                  <TableCell className={cn(edge, "py-3")}>
                    <Badge variant={TX_VARIANT[t.status]}>{TRANSACTION_STATUS_LABELS[t.status]}</Badge>
                  </TableCell>
                </TableRow>
              )
            })
          )}
        </TableBody>
      </Table>
    </>
  )
}

// ---- Transfers ----

export function TransfersTable({
  items,
  caption,
  filtered,
  select,
  busy,
}: {
  items: AdminTransfer[]
  caption: string
  filtered: boolean
  select?: Selection
  busy?: boolean
}) {
  const selection = useSelection()
  const columns = 5 + (select ? 1 : 0)
  const allOnPage = items.length > 0 && items.every((t) => selection.ids.includes(t._id))

  return (
    <>
      {select && (
        <SelectionBar count={selection.ids.length}>{select.action(selection.ids, selection.clear)}</SelectionBar>
      )}
      <Table aria-busy={busy} className="min-w-200">
        <caption className="sr-only">{caption}</caption>
        <TableHeader className="bg-muted/60">
          <TableRow className="hover:bg-transparent">
            {select && (
              <TableHead scope="col" className={cn(head, edge, "w-10")}>
                <Checkbox
                  aria-label="Select every transfer on this page"
                  checked={allOnPage}
                  onCheckedChange={(c) => selection.setIds(c ? items.map((t) => t._id) : [])}
                  disabled={!items.length}
                />
              </TableHead>
            )}
            <TableHead scope="col" className={cn(head, edge)}>Started</TableHead>
            <TableHead scope="col" className={head}>Recipient</TableHead>
            <TableHead scope="col" className={head}>From and by</TableHead>
            <TableHead scope="col" className={cn(head, "text-right")}>Amount</TableHead>
            <TableHead scope="col" className={cn(head, edge)}>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody className={cn("transition-opacity duration-150", busy && "opacity-60")}>
          {items.length === 0 ? (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={columns} className="p-0">
                <ListEmpty filtered={filtered} noun="transfers" />
              </TableCell>
            </TableRow>
          ) : (
            items.map((t) => (
              <TableRow key={t._id}>
                {select && (
                  <TableCell className={cn(edge, "py-3")}>
                    <Checkbox
                      aria-label={`Select transfer of ${formatNaira(t.amountKobo)} to ${t.recipient.accountName}`}
                      checked={selection.ids.includes(t._id)}
                      onCheckedChange={(c) => selection.toggle(t._id, !!c)}
                    />
                  </TableCell>
                )}
                <TableCell className={cn(edge, "py-3")}>
                  <When iso={t.createdAt} />
                </TableCell>
                <TableCell className="py-3">
                  <div className="grid min-w-48 gap-0.5">
                    <span className="flex flex-wrap items-center gap-1.5 font-medium">
                      {t.recipient.accountName}
                      {t.recipient.business && t.kind !== "internal" && (
                        <Link
                          href={`/businesses/${t.recipient.business}/activity`}
                          className="inline-flex items-center gap-1 rounded-md bg-brand-subtle px-1.5 py-px text-[11px] font-normal text-primary hover:underline"
                        >
                          <Building2 className="size-3" aria-hidden />
                          On LinkPay
                        </Link>
                      )}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {t.kind === "internal"
                        ? `${TRANSFER_KIND_LABELS.internal}: ${t.recipient.branch?.name ?? "another branch"}`
                        : [t.recipient.bankName, t.recipient.accountNumber].filter(Boolean).join(", ")}
                    </span>
                    {t.narration && <span className="max-w-64 truncate text-xs text-muted-foreground">{t.narration}</span>}
                  </div>
                </TableCell>
                <TableCell className="py-3">
                  <div className="grid gap-0.5">
                    <span>{t.branch?.name ?? "Unknown branch"}</span>
                    <span className="text-xs text-muted-foreground">{t.createdBy?.name ?? "Unknown"}</span>
                  </div>
                </TableCell>
                <TableCell className="py-3 text-right">
                  <span className="figure font-medium whitespace-nowrap">{formatNaira(t.amountKobo)}</span>
                  {t.feeKobo > 0 && (
                    <div className="text-xs text-muted-foreground figure whitespace-nowrap">Fee {formatNaira(t.feeKobo)}</div>
                  )}
                </TableCell>
                <TableCell className={cn(edge, "py-3")}>
                  <div className="grid gap-1">
                    <Badge variant={TRANSFER_VARIANT[t.status]}>{TRANSFER_STATUS_LABELS[t.status]}</Badge>
                    {t.awaitingProvider && t.providerError && (
                      <span className="flex max-w-48 items-start gap-1 text-xs text-warning-foreground dark:text-warning">
                        <Hourglass className="mt-px size-3 shrink-0" aria-hidden />
                        {t.providerError}
                      </span>
                    )}
                    {t.status === "failed" && t.failureReason && (
                      <span className="max-w-48 text-xs text-muted-foreground">{t.failureReason}</span>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </>
  )
}
