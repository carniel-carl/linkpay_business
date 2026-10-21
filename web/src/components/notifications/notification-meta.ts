import {
  ArrowDownLeft,
  ArrowUpRight,
  BadgeCheck,
  CalendarClock,
  CircleCheck,
  CircleX,
  Eye,
  FilePen,
  FileText,
  Hourglass,
  KeyRound,
  Landmark,
  LockOpen,
  PiggyBank,
  ReceiptText,
  ShieldX,
  TriangleAlert,
  UserCog,
  UserMinus,
  Users,
  type LucideIcon,
} from "lucide-react"
import type { NotificationType } from "@/lib/api/types"

export type NotificationTone = "default" | "success" | "warning" | "danger"

/** The icon and tone of each kind of notification. Unknown types (a newer backend) fall back to the default. */
export const NOTIFICATION_META: Record<NotificationType, { icon: LucideIcon; tone: NotificationTone }> = {
  "transfer.approval_requested": { icon: Hourglass, tone: "warning" },
  "transfer.approved": { icon: CircleCheck, tone: "success" },
  "transfer.rejected": { icon: CircleX, tone: "danger" },
  "transfer.completed": { icon: ArrowUpRight, tone: "success" },
  "transfer.failed": { icon: TriangleAlert, tone: "danger" },
  "payment.received": { icon: ArrowDownLeft, tone: "success" },
  "invoice.viewed": { icon: Eye, tone: "default" },
  "invoice.payment_received": { icon: FileText, tone: "default" },
  "invoice.paid": { icon: ReceiptText, tone: "success" },
  "invoice.overdue": { icon: CalendarClock, tone: "warning" },
  "kyb.approved": { icon: BadgeCheck, tone: "success" },
  "kyb.changes_requested": { icon: FilePen, tone: "warning" },
  "kyb.rejected": { icon: ShieldX, tone: "danger" },
  "account.ready": { icon: Landmark, tone: "success" },
  "team.member_joined": { icon: Users, tone: "default" },
  "team.role_changed": { icon: UserCog, tone: "default" },
  "team.removed": { icon: UserMinus, tone: "danger" },
  "security.new_sign_in": { icon: KeyRound, tone: "warning" },
  "savings.target_reached": { icon: PiggyBank, tone: "success" },
  "savings.safelock_released": { icon: LockOpen, tone: "success" },
}

export const TONE_CLASSES: Record<NotificationTone, string> = {
  default: "bg-brand-subtle text-primary",
  success: "bg-success-subtle text-success",
  warning: "bg-warning-subtle text-warning",
  danger: "bg-destructive-subtle text-destructive",
}

export function metaFor(type: string) {
  return NOTIFICATION_META[type as NotificationType] ?? { icon: FileText, tone: "default" as const }
}
