import { Schema, Types, model, type HydratedDocument, type InferSchemaType } from "mongoose";

export const AUDIT_ACTIONS = [
  // Verification and accounts
  "kyb.approved",
  "kyb.changes_requested",
  "kyb.rejected",
  // A staff member opened a KYB document (they hold personal data).
  "kyb.document_opened",
  "account.provision_retried",
  "transactions.synced",
  // Compliance
  "flag.raised",
  "flag.resolved",
  "note.added",
  "business.suspended",
  "business.reinstated",
  "business.banned",
  "business.unbanned",
  // Payment links and donations (reports from the public)
  "link_report.resolved",
  "payment_link.taken_down",
  "payment_link.restored",
  "donation.hidden",
  "donation.shown",
  // Staff management
  "staff.invited",
  "staff.invite_resent",
  "staff.invite_revoked",
  "staff.role_changed",
  "staff.disabled",
  "staff.enabled",
  "staff.signed_out",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * Who did what in the admin console, and what the automatic risk rules did. Append-only: nothing in the
 * API edits or deletes entries. Compliance notes are entries too (`note.added`), so a business's
 * timeline is one list.
 */
const auditLogSchema = new Schema(
  {
    actor: {
      type: { type: String, enum: ["staff", "system"], required: true },
      staff: { type: Types.ObjectId, ref: "Staff" },
      // Copied so the log still reads right after a staff member is renamed.
      name: { type: String, required: true },
    },
    action: { type: String, enum: AUDIT_ACTIONS, required: true },
    business: { type: Types.ObjectId, ref: "Business" },
    target: {
      kind: { type: String, enum: ["business", "flag", "staff", "staff_invite", "branch", "payment_link", "checkout", "link_report"] },
      id: { type: Types.ObjectId },
    },
    // One readable line, e.g. "Suspended: Suspicious transactions".
    summary: { type: String, required: true },
    details: { type: Schema.Types.Mixed, default: {} },
    ip: String,
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    minimize: false,
    toJSON: {
      transform: (_doc, ret: Record<string, any>) => {
        delete ret.__v;
        return ret;
      },
    },
  },
);

auditLogSchema.index({ business: 1, _id: -1 });
auditLogSchema.index({ "actor.staff": 1, _id: -1 });
auditLogSchema.index({ action: 1, _id: -1 });

export type AuditLog = InferSchemaType<typeof auditLogSchema>;
export type AuditLogDocument = HydratedDocument<AuditLog>;
export const AuditLogModel = model("AuditLog", auditLogSchema, "auditLogs");
