import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { Ban, CirclePause, ShieldCheck } from "lucide-react"
import { AdminSection } from "@/components/admin/admin-section"
import { BusinessHeader } from "@/components/admin/business-header"
import { Timeline } from "@/components/compliance/audit-list"
import { AddNoteDialog, RaiseFlagDialog, RestrictionDialog } from "@/components/compliance/dialogs"
import { FlagSheet } from "@/components/compliance/flag-sheet"
import { FlagsList } from "@/components/compliance/flags-list"
import type { ComplianceRules, ComplianceState } from "@/lib/api/types"
import { getAdminBusiness, getBusinessCompliance, getComplianceRules, getStaff } from "@/lib/data"
import { formatDateTime, timeAgo } from "@/lib/format"
import { requirePermission } from "@/lib/guard"
import { can } from "@/lib/permissions"
import { cn } from "@/lib/utils"

export async function generateMetadata({ params }: PageProps<"/businesses/[id]/compliance">): Promise<Metadata> {
  if (!can(await getStaff(), "businesses.view")) return { title: "Compliance" }
  const overview = await getAdminBusiness((await params).id)
  return { title: overview ? `${overview.business.name}: compliance` : "Business not found" }
}

export default async function BusinessCompliancePage({ params }: PageProps<"/businesses/[id]/compliance">) {
  const blocked = (await requirePermission("businesses.view", "Compliance")) ?? (await requirePermission("compliance.view", "Compliance"))
  if (blocked) return blocked
  const { id } = await params
  const [overview, staff, view, rules] = await Promise.all([getAdminBusiness(id), getStaff(), getBusinessCompliance(id), getComplianceRules()])
  if (!overview || !view) notFound()
  const { business } = overview
  const canManage = can(staff, "compliance.manage")
  const name = business.name
  // Open flags first, each group newest first (the API sends newest first).
  const flags = [...view.flags.filter((f) => f.status === "open"), ...view.flags.filter((f) => f.status !== "open")]
  const open = view.flags.length - flags.filter((f) => f.status !== "open").length

  return (
    <>
      <BusinessHeader
        overview={overview}
        staff={staff}
        tab="compliance"
        actions={
          canManage && (
            <>
              <AddNoteDialog businessId={id} />
              <RaiseFlagDialog businessId={id} businessName={name} categories={rules.categories} />
            </>
          )
        }
      />

      <div className="stagger grid gap-6">
        <div style={{ "--i": 0 } as React.CSSProperties}>
          <StatusPanel
            state={view.compliance}
            businessId={id}
            businessName={name}
            approved={business.status === "approved"}
            categories={rules.categories}
            canManage={canManage}
            canBan={can(staff, "compliance.ban")}
          />
        </div>

        <div style={{ "--i": 1 } as React.CSSProperties} className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
          <AdminSection
            id="flags"
            title="Flags"
            flush
            aside={
              <span className="figure text-xs text-muted-foreground">
                {open} open, {view.flags.length - open} resolved
              </span>
            }
          >
            <FlagsList
              flags={flags}
              showBusiness={false}
              caption={`Flags raised on ${name}`}
              empty={{ title: "No flags", description: "Neither staff nor the automatic checks have flagged this business." }}
            />
          </AdminSection>

          <AdminSection id="timeline" title="Timeline">
            <Timeline businessId={id} entries={view.timeline} nextBefore={view.timelineNextBefore} />
          </AdminSection>
        </div>
      </div>

      <FlagSheet canManage={canManage} />
    </>
  )
}

function StatusPanel({
  state,
  businessId,
  businessName,
  approved,
  categories,
  canManage,
  canBan,
}: {
  state: ComplianceState
  businessId: string
  businessName: string
  approved: boolean
  categories: ComplianceRules["categories"]
  canManage: boolean
  canBan: boolean
}) {
  const common = { businessId, businessName, categories }
  const actions = (
    <div className="flex flex-wrap gap-2">
      {state.status === "active" && canManage && approved && <RestrictionDialog action="suspend" {...common} />}
      {state.status === "suspended" && canManage && <RestrictionDialog action="reinstate" {...common} />}
      {state.status !== "banned" && canBan && <RestrictionDialog action="ban" {...common} defaultReason={state.reason} />}
      {state.status === "banned" && canBan && <RestrictionDialog action="unban" {...common} />}
    </div>
  )

  if (state.status === "active") {
    return (
      <div className="surface flex flex-wrap items-center justify-between gap-4 p-5 sm:p-6">
        <div className="flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-[30%] bg-success-subtle text-success-foreground">
            <ShieldCheck className="size-5" aria-hidden />
          </span>
          <div className="grid gap-0.5">
            <h2 className="font-display text-base font-semibold tracking-[-0.01em]">Active, no restrictions</h2>
            <p className="text-sm text-muted-foreground">
              {state.openFlags
                ? `${state.openFlags} open ${state.openFlags === 1 ? "flag" : "flags"}. The business can use everything while staff look into ${state.openFlags === 1 ? "it" : "them"}.`
                : "The business can use everything."}
              {!approved && " It isn't approved yet, so it can be closed but not suspended."}
            </p>
          </div>
        </div>
        {actions}
      </div>
    )
  }

  const banned = state.status === "banned"
  const Icon = banned ? Ban : CirclePause
  return (
    <section
      aria-labelledby="restriction-title"
      className={cn("surface border-l-4 p-5 sm:p-6", banned ? "border-l-destructive" : "border-l-warning")}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <span
            className={cn(
              "flex size-10 shrink-0 items-center justify-center rounded-[30%]",
              banned ? "bg-destructive-subtle text-destructive" : "bg-warning-subtle text-warning-foreground",
            )}
          >
            <Icon className="size-5" aria-hidden />
          </span>
          <div className="grid gap-1">
            <h2 id="restriction-title" className="font-display text-base font-semibold tracking-[-0.01em]">
              {banned ? "Closed" : "Suspended"}
              {state.reasonLabel && <span className="font-sans font-normal text-muted-foreground">: {state.reasonLabel}</span>}
            </h2>
            <p className="text-sm text-muted-foreground">
              {state.by ? `By ${state.by.name}` : "By staff"}
              {state.since && (
                <>
                  , <span title={formatDateTime(state.since)}>{timeAgo(state.since)}</span> ({formatDateTime(state.since)})
                </>
              )}
              .{" "}
              {banned
                ? "Every member is locked out and other businesses can't pay it."
                : "The team can look but can't send money or change anything. Approved transfers are held."}
            </p>
          </div>
        </div>
        {actions}
      </div>
      {state.note && (
        <blockquote className="mt-4 rounded-xl bg-muted/60 p-4 text-sm whitespace-pre-line">{state.note}</blockquote>
      )}
    </section>
  )
}
