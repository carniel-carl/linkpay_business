import { Code2, Globe, Lock } from "lucide-react"
import { PageHeader } from "@/components/common/page-header"
import { Badge } from "@/components/ui/badge"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import type { CheckoutStatus, LinkCheckout, PaymentLink } from "@/lib/api/types"
import { CHECKOUT_STATUS_LABELS, linkStateLabel, originLabel } from "@/lib/payment-links"
import { cn } from "@/lib/utils"

const CHECKOUT_VARIANT: Record<CheckoutStatus, React.ComponentProps<typeof Badge>["variant"]> = {
  pending: "secondary",
  expired: "muted",
  paid: "success",
  underpaid: "warning",
}

export function CheckoutStatusBadge({ status, className }: { status: CheckoutStatus; className?: string }) {
  return (
    <Badge variant={CHECKOUT_VARIANT[status] ?? "muted"} className={className}>
      {CHECKOUT_STATUS_LABELS[status] ?? status}
    </Badge>
  )
}

/** "On", or why the link isn't taking payments ("Turned off", "Ended", "Limit reached"). */
export function LinkStateBadge({ link, className }: { link: Pick<PaymentLink, "available" | "unavailableReason">; className?: string }) {
  return (
    <Badge variant={link.available ? "success" : link.unavailableReason === "inactive" ? "muted" : "warning"} className={className}>
      {linkStateLabel(link)}
    </Badge>
  )
}

/** Where a checkout started: the link's page, or the business's website (and which one). */
export function SourceTag({ checkout }: { checkout: Pick<LinkCheckout, "source" | "embedOrigin"> }) {
  if (checkout.source !== "embed") return null
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      <Code2 className="size-3.5" aria-hidden />
      {checkout.embedOrigin ? originLabel(checkout.embedOrigin) : "Your website"}
    </span>
  )
}

/** The websites a link is limited to, or "Any website". */
export function OriginsList({ origins, className }: { origins: string[]; className?: string }) {
  if (!origins.length) {
    return (
      <span className={cn("inline-flex items-center gap-1.5 text-sm text-muted-foreground", className)}>
        <Globe className="size-4" aria-hidden />
        Any website
      </span>
    )
  }
  return (
    <ul className={cn("flex flex-wrap gap-1.5", className)}>
      {origins.map((o) => (
        <li key={o} className="rounded-md bg-muted px-2 py-0.5 font-mono text-xs">
          {originLabel(o)}
        </li>
      ))}
    </ul>
  )
}

/** Pill segmented control used in the form (fixed or flexible amount, phone mode). */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T
  options: readonly (readonly [T, string])[]
  onChange: (value: T) => void
  label: string
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex h-9 w-fit max-w-full items-center gap-0.5 overflow-x-auto rounded-full bg-muted p-0.5">
      {options.map(([key, text]) => (
        <button
          key={key}
          type="button"
          role="radio"
          aria-checked={value === key}
          onClick={() => onChange(key)}
          className={cn(
            "h-8 shrink-0 rounded-full px-3.5 text-sm font-medium whitespace-nowrap transition-colors duration-150 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
            value === key ? "bg-card text-foreground shadow-surface" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {text}
        </button>
      ))}
    </div>
  )
}

/** For members without `accounts.view`. */
export function PaymentLinksLocked() {
  return (
    <>
      <PageHeader title="Payment links" description="Take payments with a link or a button on your website." />
      <Empty className="surface min-h-80 border-0 p-10">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Lock aria-hidden />
          </EmptyMedia>
          <EmptyTitle>Payment links aren&apos;t part of your role</EmptyTitle>
          <EmptyDescription>Ask the business owner or an admin if you need to see or create payment links.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </>
  )
}
