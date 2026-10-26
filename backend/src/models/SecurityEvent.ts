import { Schema, Types, model, type InferSchemaType } from "mongoose";

export const SECURITY_EVENT_TYPES = [
  "step_up.failed",
  "step_up.locked",
  "two_factor.changed",
  "member.hold_started",
  "settlement.requested",
  "settlement.cancelled",
  "settlement.approved",
  "settlement.rejected",
  "settlement.activated",
  "settlement.removed",
  "settlement.name_changed",
  "withdrawal.created",
  "money_out.frozen",
  "money_out.unfrozen",
  "settlement_only.enabled",
  "settlement_only.off_requested",
  "settlement_only.off_cancelled",
  "settlement_only.off_rejected",
  "settlement_only.disabled",
  "report.received",
] as const;
export type SecurityEventType = (typeof SECURITY_EVENT_TYPES)[number];

/**
 * The business's own security activity log (who added a settlement account, froze money out, failed a
 * code...). Append-only. Staff actions also go to the staff AuditLog.
 */
const securityEventSchema = new Schema(
  {
    // Null for events about a person only (a two-step change, a step-up lockout outside a business).
    business: { type: Types.ObjectId, ref: "Business" },
    user: { type: Types.ObjectId, ref: "User" },
    actor: {
      type: { type: String, enum: ["user", "staff", "report", "system"], required: true },
      id: { type: Types.ObjectId },
      name: { type: String, required: true },
    },
    type: { type: String, enum: SECURITY_EVENT_TYPES, required: true },
    summary: { type: String, required: true },
    details: { type: Schema.Types.Mixed, default: {} },
    ip: { type: String },
    userAgent: { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false }, minimize: false },
);

securityEventSchema.index({ business: 1, createdAt: -1 });
securityEventSchema.index({ user: 1, type: 1, createdAt: -1 });

export type SecurityEvent = InferSchemaType<typeof securityEventSchema>;
export const SecurityEventModel = model("SecurityEvent", securityEventSchema);
