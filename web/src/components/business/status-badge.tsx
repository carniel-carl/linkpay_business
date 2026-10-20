import { CircleCheck, CircleDashed, Clock, TriangleAlert, XCircle } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { STATUS_LABELS, type BusinessStatus } from "@/lib/kyb"
import { cn } from "@/lib/utils"

const VARIANT = {
  draft: { variant: "muted", icon: CircleDashed, ink: "text-brand-surface-muted" },
  submitted: { variant: "outline", icon: Clock, ink: "text-brand-surface-foreground" },
  changes_requested: { variant: "warning", icon: TriangleAlert, ink: "text-warning-foreground dark:text-warning" },
  approved: { variant: "success", icon: CircleCheck, ink: "text-success" },
  rejected: { variant: "destructive", icon: XCircle, ink: "text-destructive" },
} as const

/** `tone="ink"` renders a translucent chip for the dark brand surface. */
export function StatusBadge({ status, tone = "paper" }: { status: BusinessStatus; tone?: "paper" | "ink" }) {
  const { variant, icon: Icon, ink } = VARIANT[status]
  if (tone === "ink") {
    return (
      <Badge className="border-brand-surface-foreground/12 bg-brand-surface-foreground/[0.07] text-brand-surface-foreground">
        <Icon data-icon="inline-start" className={cn(ink)} aria-hidden />
        {STATUS_LABELS[status]}
      </Badge>
    )
  }
  return (
    <Badge variant={variant}>
      <Icon data-icon="inline-start" aria-hidden />
      {STATUS_LABELS[status]}
    </Badge>
  )
}
