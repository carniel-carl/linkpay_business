import Link from "next/link"
import { ArrowRight, TriangleAlert } from "lucide-react"
import { WriteGate } from "@/components/shell/write-gate"
import { Button } from "@/components/ui/button"
import type { ApprovalTier, TransferSettings } from "@/lib/api/types"
import { formatNaira } from "@/lib/format"
import { describeApprovalRule } from "@/lib/transfers"

/** "₦100,000 to ₦999,999.99", or "₦1,000,000 and above" for the top band. */
export function tierRange(tiers: Pick<ApprovalTier, "minKobo">[], index: number) {
  const from = tiers[index].minKobo
  const next = tiers[index + 1]?.minKobo
  if (next === undefined) return from === 0 ? "Every transfer" : `${formatNaira(from)} and above`
  return `${from === 0 ? "Up to" : `${formatNaira(from)} to`} ${formatNaira(next - 1)}`
}

/** How approvals work for this business: the workflow's bands and levels, or the simple rule. */
export function WorkflowSummary({ settings, canManage }: { settings: TransferSettings; canManage: boolean }) {
  const { approval } = settings
  const tiers = approval.mode === "workflow" ? approval.tiers : []

  return (
    <section className="surface grid gap-5 p-5 sm:p-6" aria-labelledby="workflow-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <h2 id="workflow-title" className="font-medium">
            {tiers.length ? "Approval levels" : "How approvals work now"}
          </h2>
          <p className="max-w-prose text-sm text-muted-foreground">
            {tiers.length
              ? `A transfer uses the band its amount falls in. Levels go in order, and any one person at a level clears it. Nobody approves their own transfer or two levels of the same one.${
                  tiers[0].minKobo > 0
                    ? ` Under ${formatNaira(tiers[0].minKobo)}, transfers go straight away unless the sender can't approve transfers.`
                    : ""
                }`
              : `${describeApprovalRule(settings)} Set up levels to name who approves, in order, with bigger amounts going through more people.`}
          </p>
        </div>
        {canManage && (
          // Disabled, with the reason, while the business is suspended, like the page header's button.
          <WriteGate>
            <Button asChild variant="ghost" size="sm">
              <Link href="/approvals/setup">
                {tiers.length ? "Edit" : "Set up levels"}
                <ArrowRight data-icon="inline-end" aria-hidden />
              </Link>
            </Button>
          </WriteGate>
        )}
      </div>

      {tiers.length > 0 && (
        <ol className="grid gap-3 md:grid-cols-2">
          {tiers.map((tier, i) => (
            <li key={tier.minKobo} className="grid content-start gap-3 rounded-xl border p-4">
              <p className="text-sm font-medium figure">{tierRange(tiers, i)}</p>
              <ol className="grid gap-2.5">
                {tier.levels.map((level, j) => {
                  const active = level.approvers.filter((a) => a.canApprove)
                  const gone = level.approvers.filter((a) => !a.canApprove)
                  return (
                    <li key={j} className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                      <span className="grid size-6 place-items-center rounded-full bg-muted text-xs font-medium figure" aria-hidden>
                        {j + 1}
                      </span>
                      <div className="grid gap-1">
                        <p>
                          <span className="sr-only">Level {j + 1}: </span>
                          {active.length ? active.map((a) => a.name).join(", ") : <span className="text-destructive">Nobody can approve</span>}
                        </p>
                        {gone.length > 0 && (
                          <p className="flex items-start gap-1.5 text-xs text-warning-foreground">
                            <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
                            {gone.map((a) => a.name).join(", ")} can no longer approve.
                            {active.length === 0 && " Transfers in this band are refused until someone is added."}
                          </p>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ol>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
