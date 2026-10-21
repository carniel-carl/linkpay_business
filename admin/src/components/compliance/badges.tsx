import { Ban, CirclePause, Flag, ShieldAlert } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import type { ComplianceStatus, FlagSeverity } from "@/lib/api/types"
import { COMPLIANCE_LABELS, SEVERITY_LABELS } from "@/lib/compliance"
import { cn } from "@/lib/utils"

const SEVERITY = {
  high: { variant: "destructive", dot: "bg-destructive" },
  medium: { variant: "warning", dot: "bg-warning" },
  low: { variant: "muted", dot: "bg-muted-foreground" },
} as const

/** Severity as a status tag: icon plus label, never colour alone. */
export function SeverityBadge({ severity }: { severity: FlagSeverity }) {
  return (
    <Badge variant={SEVERITY[severity].variant}>
      <Flag data-icon="inline-start" aria-hidden />
      {SEVERITY_LABELS[severity]}
    </Badge>
  )
}

/** A small dot for dense rows. The label rides along for screen readers and on hover. */
export function SeverityDot({ severity, className }: { severity: FlagSeverity; className?: string }) {
  return (
    <span
      title={`${SEVERITY_LABELS[severity]} severity`}
      className={cn("inline-block size-2 shrink-0 rounded-full", SEVERITY[severity].dot, className)}
    >
      <span className="sr-only">{SEVERITY_LABELS[severity]} severity</span>
    </span>
  )
}

const RESTRICTION = {
  suspended: { variant: "warning", icon: CirclePause, ink: "text-warning-foreground dark:text-warning" },
  banned: { variant: "destructive", icon: Ban, ink: "text-destructive" },
} as const

/** "Suspended" or "Closed". Renders nothing for an active business. `tone="ink"` is for the band. */
export function RestrictionBadge({ status, tone = "paper" }: { status?: ComplianceStatus; tone?: "paper" | "ink" }) {
  if (!status || status === "active") return null
  const { variant, icon: Icon, ink } = RESTRICTION[status]
  if (tone === "ink") {
    return (
      <Badge className="border-brand-surface-foreground/12 bg-brand-surface-foreground/[0.07] text-brand-surface-foreground">
        <Icon data-icon="inline-start" className={ink} aria-hidden />
        {COMPLIANCE_LABELS[status]}
      </Badge>
    )
  }
  return (
    <Badge variant={variant}>
      <Icon data-icon="inline-start" aria-hidden />
      {COMPLIANCE_LABELS[status]}
    </Badge>
  )
}

/** "2 open flags" on the band, with the highest severity's icon colour. */
export function OpenFlagsBadge({ count, severity }: { count: number; severity: FlagSeverity | null }) {
  if (!count) return null
  return (
    <Badge className="border-brand-surface-foreground/12 bg-brand-surface-foreground/[0.07] text-brand-surface-foreground">
      <ShieldAlert
        data-icon="inline-start"
        className={cn(severity === "high" ? "text-destructive" : severity === "medium" ? "text-warning-foreground dark:text-warning" : "")}
        aria-hidden
      />
      <span className="figure">{count}</span> open {count === 1 ? "flag" : "flags"}
    </Badge>
  )
}
