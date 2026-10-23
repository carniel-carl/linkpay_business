import { Lock } from "lucide-react"
import { PageHeader } from "@/components/common/page-header"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import type { BeneficiaryLike } from "@/lib/payouts"
import { cn } from "@/lib/utils"

/** The bank's name for the account (who gets paid), the nickname beside it, then bank and account number. */
export function BeneficiaryName({ beneficiary: b, className }: { beneficiary: BeneficiaryLike; className?: string }) {
  return (
    <span className={cn("grid min-w-0 gap-0.5", className)}>
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        <span className="font-medium break-words">{b.accountName}</span>
        {b.nickname && <span className="truncate text-xs text-muted-foreground">{b.nickname}</span>}
      </span>
      <span className="truncate text-xs text-muted-foreground">
        {b.bankName ?? "Bank"} · <span className="font-mono">{b.accountNumber}</span>
      </span>
    </span>
  )
}

/** For members whose role can't see accounts. */
export function PayoutsLocked({ title }: { title: string }) {
  return (
    <>
      <PageHeader title={title} description="People and lists your business pays." />
      <Empty className="surface min-h-80 border-0 p-10">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Lock aria-hidden />
          </EmptyMedia>
          <EmptyTitle>Payouts aren&apos;t part of your role</EmptyTitle>
          <EmptyDescription>Ask the business owner or an admin if you need to pay people or see who the business pays.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </>
  )
}
