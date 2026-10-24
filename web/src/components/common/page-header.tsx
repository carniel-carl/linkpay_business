import Link from "next/link"
import { ArrowLeft } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * Page title block. On band layouts (dashboard, admin) it becomes the full-width ink band and the
 * next sibling overlaps its lower edge (see globals.css). Elsewhere it's a plain header.
 */
export function PageHeader({
  title,
  description,
  actions,
  back,
  className,
}: {
  back?: { href: string; label: string }
  title: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  className?: string
}) {
  return (
    <header
      data-slot="page-header"
      className={cn(
        "mb-10 flex flex-wrap items-end justify-between gap-x-8 gap-y-5",
        "on-band:band on-band:mb-0 on-band:pt-10 on-band:pb-[7.5rem] md:on-band:pt-14",
        className,
      )}
    >
      <div className="grid max-w-[62ch] gap-3">
        {back && (
          <Link
            href={back.href}
            className="mb-1 inline-flex w-fit items-center gap-1.5 rounded-full text-sm text-muted-foreground transition-colors duration-200 hover:text-foreground on-band:text-brand-surface-muted on-band:hover:text-brand-surface-foreground"
          >
            <ArrowLeft className="size-4" aria-hidden />
            {back.label}
          </Link>
        )}
        <h1 className="type-display text-[2.125rem] text-balance sm:text-[2.75rem] on-band:text-brand-surface-foreground">
          {title}
        </h1>
        {description && (
          <div className="text-[15px] leading-relaxed text-pretty text-muted-foreground on-band:text-brand-surface-muted">
            {description}
          </div>
        )}
      </div>
      {/* Wraps rather than running off a narrow screen; pages with several actions also show icons only on phones. */}
      {actions && <div className="flex max-w-full shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  )
}
