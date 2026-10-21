import type { Metadata } from "next"
import Link from "next/link"
import { ArrowUpRight } from "lucide-react"
import { ListFilters } from "@/components/activity/list-filters"
import { AdminSection } from "@/components/admin/admin-section"
import { SeverityBadge } from "@/components/compliance/badges"
import { FlagSheet } from "@/components/compliance/flag-sheet"
import { FlagsList } from "@/components/compliance/flags-list"
import { RunChecksButton } from "@/components/compliance/run-checks-button"
import { PageHeader } from "@/components/common/page-header"
import { Pager } from "@/components/common/url-state"
import type { ComplianceSummary, RiskRuleInfo } from "@/lib/api/types"
import { FLAG_STATUSES, PAGE_SIZE, parseFlagQuery, SEVERITIES, SEVERITY_LABELS, windowLabel, type FlagQuery } from "@/lib/compliance"
import { getComplianceRules, getComplianceSummary, getFlags, getStaff } from "@/lib/data"
import { requirePermission } from "@/lib/guard"
import { can } from "@/lib/permissions"
import { cn } from "@/lib/utils"

export const metadata: Metadata = { title: "Compliance" }

const STATUS_TAB_LABELS: Record<FlagQuery["status"], string> = { open: "Open", resolved: "Resolved", all: "All" }

export default async function CompliancePage({ searchParams }: PageProps<"/compliance">) {
  const blocked = await requirePermission("compliance.view", "Compliance")
  if (blocked) return blocked
  const raw = await searchParams
  const query = parseFlagQuery(raw)
  const [staff, summary, rules, flags] = await Promise.all([getStaff(), getComplianceSummary(), getComplianceRules(), getFlags(query)])
  const canManage = can(staff, "compliance.manage")
  const filtered = !!(query.severity || query.source || query.rule)

  return (
    <>
      <PageHeader
        title="Compliance"
        description="Flags from the automatic risk checks and from staff, and the businesses that are suspended or closed."
        actions={canManage && <RunChecksButton />}
      />

      <div className="stagger grid gap-6">
        <div style={{ "--i": 0 } as React.CSSProperties}>
          <SummaryTiles summary={summary} />
        </div>

        <div style={{ "--i": 1 } as React.CSSProperties} className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
          <section aria-labelledby="queue-title" className="surface min-w-0 overflow-hidden">
            <h2 id="queue-title" className="sr-only">
              Flags
            </h2>
            <nav aria-label="Filter by status" className="overflow-x-auto border-b px-4 sm:px-6">
              <ul className="flex w-max min-w-full gap-1">
                {FLAG_STATUSES.map((s) => {
                  const params = new URLSearchParams()
                  for (const key of ["severity", "source", "rule"] as const) if (query[key]) params.set(key, query[key]!)
                  if (s !== "open") params.set("status", s)
                  const qs = params.toString()
                  const active = s === query.status
                  return (
                    <li key={s}>
                      <Link
                        href={qs ? `/compliance?${qs}` : "/compliance"}
                        scroll={false}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "-mb-px inline-flex h-12 items-center gap-2 border-b-2 px-3 text-sm whitespace-nowrap transition-colors duration-150",
                          "rounded-t-md focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                          active ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {STATUS_TAB_LABELS[s]}
                        {s === "open" && (
                          <span
                            className={cn(
                              "figure rounded-md px-1.5 py-px text-xs",
                              active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
                            )}
                          >
                            {summary.openFlags.total}
                          </span>
                        )}
                      </Link>
                    </li>
                  )
                })}
              </ul>
            </nav>
            <ListFilters
              id="flags"
              selects={[
                { key: "severity", label: "Severity", any: "Any severity", options: SEVERITIES.map((s) => ({ value: s, label: SEVERITY_LABELS[s] })) },
                {
                  key: "source",
                  label: "Raised by",
                  any: "Rules and staff",
                  options: [
                    { value: "rule", label: "Automatic checks" },
                    { value: "staff", label: "Staff" },
                  ],
                },
                { key: "rule", label: "Rule", any: "Any rule", options: rules.rules.map((r) => ({ value: r.key, label: r.label })) },
              ]}
            />
            <div className="border-t">
              <FlagsList
                flags={flags.items}
                caption={`${STATUS_TAB_LABELS[query.status]} flags`}
                empty={
                  filtered
                    ? { title: "No matches", description: "No flags match these filters. Clear a filter to see more." }
                    : query.status === "open"
                      ? { title: "No open flags", description: "Nothing needs looking into. New flags from the checks or from staff show here, highest severity first." }
                      : { title: "No flags yet", description: "Flags show here once the checks or staff raise them." }
                }
              />
            </div>
            <Pager total={flags.total} page={query.page} pageSize={PAGE_SIZE} noun="flags" />
          </section>

          <RulesPanel rules={rules.rules} />
        </div>
      </div>

      <FlagSheet canManage={canManage} />
    </>
  )
}

function SummaryTiles({ summary }: { summary: ComplianceSummary }) {
  const { openFlags } = summary
  const tiles = [
    {
      label: "Open flags",
      value: openFlags.total,
      href: "/compliance",
      detail: `${openFlags.high} high, ${openFlags.medium} medium, ${openFlags.low} low`,
      alert: openFlags.high > 0,
    },
    {
      label: "Flagged businesses",
      value: summary.flaggedBusinesses,
      href: "/businesses?compliance=flagged&sort=flags&dir=desc",
      detail: `${openFlags.fromRules} from checks, ${openFlags.fromStaff} from staff`,
    },
    { label: "Suspended", value: summary.suspended, href: "/businesses?compliance=suspended", detail: "Can look, can't send or change" },
    { label: "Closed", value: summary.banned, href: "/businesses?compliance=banned", detail: "Locked out" },
  ]
  return (
    <div className="grid gap-3">
      <ul aria-label="Summary" className="grid grid-cols-2 overflow-hidden surface lg:grid-cols-4">
        {tiles.map((t, i) => (
          <li
            key={t.label}
            className={cn("border-border", i % 2 === 1 && "border-l", i > 1 && "border-t lg:border-t-0", i === 2 && "lg:border-l")}
          >
            <Link
              href={t.href}
              className="group grid h-full gap-2 p-4 transition-colors duration-150 outline-none hover:bg-muted/50 focus-visible:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset sm:p-6"
            >
              <span className="flex items-start justify-between gap-2 text-sm text-muted-foreground">
                {t.label}
                <ArrowUpRight
                  className="size-4 shrink-0 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100"
                  aria-hidden
                />
              </span>
              <span className={cn("type-display figure text-3xl sm:text-4xl", t.alert && "text-destructive")}>{t.value}</span>
              <span className="text-xs text-muted-foreground">{t.detail}</span>
            </Link>
          </li>
        ))}
      </ul>
      <p className="px-1 text-xs text-muted-foreground figure">
        Last 7 days: {summary.raisedLast7d} raised, {summary.resolvedLast7d} resolved.
      </p>
    </div>
  )
}

function RulesPanel({ rules }: { rules: RiskRuleInfo[] }) {
  return (
    <AdminSection id="rules" title="Automatic checks" flush aside={<span className="text-xs text-muted-foreground">Every 5 minutes</span>}>
      <ul className="divide-y">
        {rules.map((r) => (
          <li key={r.key} className="grid gap-1.5 px-5 py-4 sm:px-6">
            <div className="flex items-start justify-between gap-3">
              <span className="text-sm font-medium">{r.label}</span>
              <SeverityBadge severity={r.severity} />
            </div>
            <p className="text-xs text-pretty text-muted-foreground">{r.description}</p>
            <p className="text-xs text-muted-foreground">Looks back {windowLabel(r.windowHours)}.</p>
          </li>
        ))}
      </ul>
      <p className="border-t px-5 py-3 text-xs text-muted-foreground sm:px-6">
        Each check keeps one open flag per business. Once it&apos;s resolved, only newer activity counts.
      </p>
    </AdminSection>
  )
}
