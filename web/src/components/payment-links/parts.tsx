import { Code2, FlaskConical, Globe, HandHeart, Lock } from "lucide-react"
import { PageHeader } from "@/components/common/page-header"
import { Badge } from "@/components/ui/badge"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import type { CheckoutStatus, LinkCheckout, PaymentLink, PaymentMode } from "@/lib/api/types"
import { formatNaira } from "@/lib/format"
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

/** "Over limit" on a payment that came in after the link had reached its payment limit; nothing otherwise. */
export function OverLimitBadge({ overLimit, className }: { overLimit?: boolean; className?: string }) {
  if (!overLimit) return null
  return (
    <Badge variant="warning" className={className}>
      Over limit
    </Badge>
  )
}

/** "Test" on a link or checkout in test mode; nothing for live ones. */
export function TestBadge({ mode, className }: { mode: PaymentMode | undefined; className?: string }) {
  if (mode !== "test") return null
  return (
    <Badge variant="warning" className={cn("border-dashed border-warning/60", className)}>
      <FlaskConical aria-hidden />
      Test
    </Badge>
  )
}

/** A donation link's progress towards its goal, as a slim bar with the percentage; nothing without a goal. */
export function DonationBar({ link, className }: { link: Pick<PaymentLink, "donation">; className?: string }) {
  const d = link.donation
  if (!d?.goalKobo) return null
  const pct = Math.min(100, (d.raisedKobo / d.goalKobo) * 100)
  return (
    <span className={cn("flex items-center gap-2", className)}>
      <span
        role="progressbar"
        aria-label="Raised towards the goal"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
        className="h-1.5 w-20 overflow-hidden rounded-full bg-muted"
      >
        <span className="block h-full rounded-full bg-(--fund-progress)" style={{ width: `${pct}%` }} />
      </span>
      <span className="text-xs text-muted-foreground figure">{d.percent}%</span>
    </span>
  )
}

/** "+ ₦5,000 in test" under a test-mode link's collected figure: simulated payments, never real money. */
export function TestTotal({ test, className }: { test: PaymentLink["test"]; className?: string }) {
  if (!test?.collectedKobo) return null
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs whitespace-nowrap text-warning-foreground", className)}>
      <FlaskConical className="size-3" aria-hidden />+ <span className="figure">{formatNaira(test.collectedKobo)}</span> in test
    </span>
  )
}

/** "Donation" on fundraiser links, so they stand out in lists. */
export function KindBadge({ link, className }: { link: Pick<PaymentLink, "kind">; className?: string }) {
  if (link.kind !== "donation") return null
  return (
    <Badge variant="donation" className={className}>
      <HandHeart aria-hidden />
      Donation
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
