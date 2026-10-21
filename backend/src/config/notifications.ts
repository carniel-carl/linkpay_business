// Every kind of in-app notification, who gets it, and whether it also goes out as a phone push.
// Business users get "user" notifications in the web and mobile apps; staff get "staff" ones in admin/.

export const NOTIFICATION_TYPES = {
  // ---- Business users ----
  "transfer.approval_requested": { audience: "user", label: "A transfer needs your approval", push: true },
  "transfer.approved": { audience: "user", label: "Your transfer was approved", push: true },
  "transfer.rejected": { audience: "user", label: "Your transfer wasn't approved", push: true },
  "transfer.completed": { audience: "user", label: "Your transfer was delivered", push: true },
  "transfer.failed": { audience: "user", label: "Your transfer failed", push: true },
  "payment.received": { audience: "user", label: "Money came in", push: true },
  "invoice.viewed": { audience: "user", label: "A customer opened an invoice", push: false },
  "invoice.payment_received": { audience: "user", label: "An invoice was part paid", push: true },
  "invoice.paid": { audience: "user", label: "An invoice was paid in full", push: true },
  "invoice.overdue": { audience: "user", label: "An invoice is overdue", push: true },
  "savings.target_reached": { audience: "user", label: "A savings pocket reached its target", push: true },
  "kyb.approved": { audience: "user", label: "Your business was approved", push: true },
  "kyb.changes_requested": { audience: "user", label: "Your verification needs changes", push: true },
  "kyb.rejected": { audience: "user", label: "Your verification wasn't approved", push: true },
  "account.ready": { audience: "user", label: "A bank account is ready", push: true },
  "team.member_joined": { audience: "user", label: "Someone joined your team", push: false },
  "team.role_changed": { audience: "user", label: "Your role changed", push: true },
  "team.removed": { audience: "user", label: "You were removed from a team", push: true },
  "security.new_sign_in": { audience: "user", label: "New sign-in on a device", push: true },
  "business.suspended": { audience: "user", label: "Your business was suspended", push: true },
  "business.reinstated": { audience: "user", label: "Your business was reinstated", push: true },
  "business.banned": { audience: "user", label: "Your business was closed", push: true },
  // ---- Staff (admin console) ----
  "kyb.submitted": { audience: "staff", label: "A business is waiting for review", push: false },
  "account.setup_failed": { audience: "staff", label: "A bank account couldn't be set up", push: false },
  "staff.invite_accepted": { audience: "staff", label: "Someone accepted your staff invite", push: false },
  "staff.role_changed": { audience: "staff", label: "Your staff role changed", push: false },
  "compliance.flag_raised": { audience: "staff", label: "A business was flagged", push: false },
  "compliance.business_restricted": { audience: "staff", label: "A business was suspended or closed", push: false },
} as const satisfies Record<string, { audience: "user" | "staff"; label: string; push: boolean }>;

export type NotificationType = keyof typeof NOTIFICATION_TYPES;
export const NOTIFICATION_TYPE_KEYS = Object.keys(NOTIFICATION_TYPES) as [NotificationType, ...NotificationType[]];
export type NotificationAudience = "user" | "staff";

/**
 * Android notification channel for each push, so people can mute one kind in the phone's settings.
 * The mobile app creates these channels with the same ids.
 */
export const PUSH_CHANNELS = ["payments", "transfers", "invoices", "account"] as const;
export type PushChannel = (typeof PUSH_CHANNELS)[number];
export function pushChannelOf(type: NotificationType): PushChannel {
  if (type.startsWith("payment.")) return "payments";
  if (type.startsWith("transfer.")) return "transfers";
  if (type.startsWith("invoice.")) return "invoices";
  return "account"; // verification, bank accounts, team, security, suspensions
}

/** Notifications are deleted after this long. */
export const NOTIFICATION_RETENTION_DAYS = 90;
