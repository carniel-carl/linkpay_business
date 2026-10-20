import Link from "next/link"
import { ArrowRight, Clock, Lock, TriangleAlert, XCircle } from "lucide-react"
import type { Overview } from "@/lib/api/types"
import { cn } from "@/lib/utils"

/** A line under the ink header until the business is verified. Sits on the ink band. */
export function StatusBanner({ overview }: { overview: Overview }) {
  const { status } = overview.business
  if (status === "approved") return null

  const done = overview.checklist.items.filter((i) => i.done).length
  const total = overview.checklist.items.length

  const content = {
    draft: {
      icon: Lock,
      iconClass: "text-brand-surface-muted",
      text: `Finish verification to unlock accounts and transfers. ${done} of ${total} done.`,
      href: "/onboarding",
      cta: "Continue setup",
    },
    submitted: {
      icon: Clock,
      iconClass: "text-brand-surface-muted",
      text: "We're reviewing your business. Most features unlock once you're verified.",
      href: "/onboarding/status",
      cta: "View status",
    },
    changes_requested: {
      icon: TriangleAlert,
      iconClass: "text-warning-foreground dark:text-warning",
      text: "Our review team asked for changes before we can verify your business.",
      href: "/onboarding/status",
      cta: "See what to fix",
    },
    rejected: {
      icon: XCircle,
      iconClass: "text-destructive",
      text: "We couldn't verify your business.",
      href: "/onboarding/status",
      cta: "See why",
    },
  }[status]

  const Icon = content.icon
  return (
    <div className="border-t border-brand-surface-foreground/10 bg-brand-surface text-brand-surface-foreground">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-2.5 text-sm md:px-8">
        <span className="flex min-w-0 basis-full items-start gap-2 text-brand-surface-muted sm:basis-auto sm:flex-1">
          <Icon className={cn("mt-0.5 size-4 shrink-0", content.iconClass)} aria-hidden />
          <span className="figure">{content.text}</span>
        </span>
        <Link
          href={content.href}
          className="ml-6 inline-flex items-center gap-1 font-medium text-primary underline-offset-4 hover:underline sm:ml-0"
        >
          {content.cta}
          <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      </div>
    </div>
  )
}
