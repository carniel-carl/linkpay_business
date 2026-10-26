import { ArrowLeftRight, ArrowUpRight, Building2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import type { Transfer, TransferStatus } from "@/lib/api/types"
import { formatNaira } from "@/lib/format"
import { STATUS_LABELS } from "@/lib/transfers"
import { cn } from "@/lib/utils"

const STATUS_VARIANT: Record<TransferStatus, React.ComponentProps<typeof Badge>["variant"]> = {
  pending_approval: "warning",
  processing: "secondary",
  success: "success",
  failed: "destructive",
  rejected: "destructive",
  cancelled: "muted",
}

export function TransferStatusBadge({ status }: { status: TransferStatus }) {
  return <Badge variant={STATUS_VARIANT[status] ?? "muted"}>{STATUS_LABELS[status] ?? status}</Badge>
}

/** Money out, always: "−₦1,000.00". The sign and the screen-reader word carry the meaning. */
export function TransferAmount({ kobo, className }: { kobo: number; className?: string }) {
  return (
    <span className={cn("figure font-medium whitespace-nowrap", className)}>
      <span className="sr-only">Sending </span>
      <span aria-hidden>−</span>
      {formatNaira(kobo)}
    </span>
  )
}

export function KindIcon({ transfer, className }: { transfer: Pick<Transfer, "kind">; className?: string }) {
  const Icon = transfer.kind === "internal" ? ArrowLeftRight : transfer.kind === "linkpay" ? Building2 : ArrowUpRight
  return (
    <span className={cn("grid size-9 shrink-0 place-items-center rounded-[10px] bg-muted text-muted-foreground", className)}>
      <Icon className="size-4" aria-hidden />
    </span>
  )
}

/** "Kano branch" for internal transfers, otherwise the account holder's name. */
export const recipientName = (t: Transfer) =>
  t.kind === "internal" && t.recipient.branch ? t.recipient.branch.name : t.recipient.accountName

/** "GTBank · 0123456789", or "Withdrawal · GTBank · 0123456789" to one of the business's settlement accounts. */
export const recipientBank = (t: Transfer) =>
  [t.recipient.settlementAccount ? "Withdrawal" : null, t.recipient.bankName, t.recipient.accountNumber].filter(Boolean).join(" · ")
