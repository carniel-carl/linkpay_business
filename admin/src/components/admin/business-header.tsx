import Link from "next/link"
import { OpenFlagsBadge, RestrictionBadge } from "@/components/compliance/badges"
import { StatusBadge } from "@/components/business/status-badge"
import { PageHeader } from "@/components/common/page-header"
import type { Owner, Overview, Staff } from "@/lib/api/types"
import { formatDateTime } from "@/lib/format"
import { can } from "@/lib/permissions"
import { cn } from "@/lib/utils"

export type BusinessTab = "overview" | "activity" | "compliance"

/**
 * The band on every tab of a business: name, verification and compliance status, owner, and the tabs.
 * Activity needs `activity.view` and an approved business; Compliance needs `compliance.view`.
 */
export function BusinessHeader({
  overview,
  staff,
  tab,
  actions,
}: {
  overview: Overview
  staff: Staff
  tab: BusinessTab
  actions?: React.ReactNode
}) {
  const { business } = overview
  const owner = business.owner as Owner
  const base = `/businesses/${business._id}`
  const compliance = business.compliance
  const tabs = [
    { key: "overview", label: "Overview", href: base, show: true },
    { key: "activity", label: "Activity", href: `${base}/activity`, show: can(staff, "activity.view") && business.status === "approved" },
    { key: "compliance", label: "Compliance", href: `${base}/compliance`, show: can(staff, "compliance.view") },
  ].filter((t) => t.show)

  return (
    <PageHeader
      back={business.status === "submitted" ? { href: "/", label: "Review queue" } : { href: "/businesses", label: "Businesses" }}
      title={business.name}
      description={
        <div className="grid gap-5">
          <span className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <StatusBadge status={business.status} tone="ink" />
            <RestrictionBadge status={compliance?.status} tone="ink" />
            {can(staff, "compliance.view") && (
              <OpenFlagsBadge count={compliance?.openFlags ?? 0} severity={compliance?.highestOpenSeverity ?? null} />
            )}
            <span>
              {owner?.name}, {owner?.email}
            </span>
            {business.submittedAt && <span className="figure">Submitted {formatDateTime(business.submittedAt)}</span>}
          </span>
          {tabs.length > 1 && (
            <nav aria-label="Business sections">
              <ul className="flex w-fit gap-1 rounded-full bg-brand-surface-foreground/[0.07] p-1">
                {tabs.map((t) => {
                  const active = t.key === tab
                  return (
                    <li key={t.key}>
                      <Link
                        href={t.href}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "inline-flex h-8 items-center rounded-full px-4 text-sm transition-colors duration-150 outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                          active
                            ? "bg-card font-medium text-foreground shadow-sm"
                            : "text-brand-surface-muted hover:text-brand-surface-foreground",
                        )}
                      >
                        {t.label}
                      </Link>
                    </li>
                  )
                })}
              </ul>
            </nav>
          )}
        </div>
      }
      actions={actions}
    />
  )
}
