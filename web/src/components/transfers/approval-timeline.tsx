import { Check, Circle, Clock, Minus, X } from "lucide-react"
import type { ApprovalLevelStatus, Transfer, TransferApproval, TransferApprovalLevel } from "@/lib/api/types"
import { formatDateTime } from "@/lib/format"
import { LEVEL_STATUS_LABELS } from "@/lib/transfers"
import { cn } from "@/lib/utils"

const MARKER: Record<ApprovalLevelStatus, { icon: typeof Check; className: string }> = {
  approved: { icon: Check, className: "bg-success-subtle text-success-foreground" },
  waiting: { icon: Clock, className: "bg-warning-subtle text-warning-foreground" },
  upcoming: { icon: Circle, className: "bg-muted text-muted-foreground" },
  rejected: { icon: X, className: "bg-destructive/10 text-destructive" },
  cancelled: { icon: Minus, className: "bg-muted text-muted-foreground" },
  not_reached: { icon: Minus, className: "bg-muted text-muted-foreground" },
}

/** "Ada, Bola or Chidi" */
const names = (level: TransferApprovalLevel) => {
  const list = level.approvers.map((a) => a.name)
  return list.length <= 1 ? (list[0] ?? "") : `${list.slice(0, -1).join(", ")} or ${list.at(-1)}`
}

const who = (level: TransferApprovalLevel) => (level.any || !level.approvers.length ? "anyone who can approve transfers" : names(level))

function detail(level: TransferApprovalLevel, decision: Transfer["decision"]) {
  switch (level.status) {
    case "approved":
      return level.approvedBy
        ? `${level.approvedBy.name} approved${level.approvedAt ? `, ${formatDateTime(level.approvedAt)}` : ""}`
        : "Approved"
    case "waiting":
      return `Waiting for ${who(level)}`
    case "upcoming":
      return `Then ${who(level)}`
    case "rejected":
      return decision?.by ? `${decision.by.name} rejected${decision.at ? `, ${formatDateTime(decision.at)}` : ""}` : "Rejected at this level"
    case "cancelled":
      return "Cancelled while waiting here"
    case "not_reached":
      return `Would have gone to ${who(level)}`
  }
}

/** The transfer's approval levels, in order, and where each one stands. A rejection's name and note come from `decision`. */
export function ApprovalTimeline({ approval, decision }: { approval: TransferApproval; decision: Transfer["decision"] }) {
  const single = approval.levels.length === 1
  return (
    <ol className="grid rounded-xl border px-4 py-1">
      {approval.levels.map((level, i) => {
        const { icon: Icon, className } = MARKER[level.status]
        const last = i === approval.levels.length - 1
        const note = level.status === "rejected" ? (level.note ?? decision?.note) : level.note
        return (
          <li key={level.level} className="relative flex gap-3 py-3" aria-current={level.status === "waiting" ? "step" : undefined}>
            {!last && <span aria-hidden className="absolute top-10 bottom-0 left-3.5 w-px -translate-x-1/2 bg-border" />}
            <span className={cn("relative grid size-7 shrink-0 place-items-center rounded-full", className)}>
              <Icon className="size-3.5" aria-hidden />
            </span>
            <div className="grid min-w-0 flex-1 gap-0.5 pt-0.5 text-sm">
              <p className="flex items-baseline justify-between gap-3">
                <span className="font-medium">{single ? "Approval" : `Level ${level.level}`}</span>
                <span className="text-xs text-muted-foreground">{LEVEL_STATUS_LABELS[level.status]}</span>
              </p>
              <p className="text-muted-foreground">{detail(level, decision)}</p>
              {note && <p className="mt-1 rounded-md bg-muted px-2.5 py-1.5 text-[13px]">&ldquo;{note}&rdquo;</p>}
            </div>
          </li>
        )
      })}
    </ol>
  )
}
