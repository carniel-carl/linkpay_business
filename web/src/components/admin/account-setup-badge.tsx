import { CircleCheck, CircleDashed, Clock, XCircle } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import type { AccountSetupStatus } from "@/lib/api/types"

const MAP = {
  not_started: { label: "Not started", variant: "muted", icon: CircleDashed },
  pending: { label: "Setting up", variant: "outline", icon: Clock },
  active: { label: "Active", variant: "success", icon: CircleCheck },
  failed: { label: "Setup failed", variant: "destructive", icon: XCircle },
} as const

/** Bank account setup status, for staff views only (owners never see "failed"). */
export function AccountSetupBadge({ status }: { status: AccountSetupStatus }) {
  const { label, variant, icon: Icon } = MAP[status] ?? MAP.not_started
  return (
    <Badge variant={variant}>
      <Icon data-icon="inline-start" aria-hidden />
      {label}
    </Badge>
  )
}
