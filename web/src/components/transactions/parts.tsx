import { ArrowDownLeft, ArrowUpRight } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import type { Transaction, TransactionStatus } from "@/lib/api/types"
import { formatNaira } from "@/lib/format"
import { STATUS_LABELS } from "@/lib/transactions"
import { cn } from "@/lib/utils"

const STATUS_VARIANT: Record<TransactionStatus, React.ComponentProps<typeof Badge>["variant"]> = {
  success: "success",
  pending: "warning",
  failed: "destructive",
  reversed: "muted",
}

export function TransactionStatusBadge({ status }: { status: TransactionStatus }) {
  return <Badge variant={STATUS_VARIANT[status] ?? "muted"}>{STATUS_LABELS[status] ?? status}</Badge>
}

/**
 * "+₦100.00" for money in (success colour), "−₦100.00" for money out. The sign and the screen-reader
 * word carry the meaning, so colour is never the only signal.
 */
export function Amount({
  tx,
  kobo = tx.amountKobo,
  className,
}: {
  tx: Pick<Transaction, "direction" | "amountKobo">
  kobo?: number
  className?: string
}) {
  const credit = tx.direction === "credit"
  return (
    <span className={cn("figure font-medium whitespace-nowrap", credit && "text-success-foreground", className)}>
      <span className="sr-only">{credit ? "Received " : "Sent "}</span>
      <span aria-hidden>{credit ? "+" : "−"}</span>
      {formatNaira(kobo)}
    </span>
  )
}

export function DirectionIcon({ tx, className }: { tx: Pick<Transaction, "direction">; className?: string }) {
  const credit = tx.direction === "credit"
  const Icon = credit ? ArrowDownLeft : ArrowUpRight
  return (
    <span
      className={cn(
        "grid size-9 shrink-0 place-items-center rounded-[10px]",
        credit ? "bg-success-subtle text-success-foreground" : "bg-muted text-muted-foreground",
        className,
      )}
    >
      <Icon className="size-4" aria-hidden />
    </span>
  )
}

/** The payer (or, for money out, the recipient). */
export const payerName = (tx: Transaction) =>
  tx.counterparty.name || (tx.direction === "credit" ? "Unknown payer" : "Unknown recipient")

/** "GTBank · 0123456789" */
export const payerBank = (tx: Transaction) =>
  [tx.counterparty.bankName, tx.counterparty.accountNumber].filter(Boolean).join(" · ")
