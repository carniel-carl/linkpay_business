import { Schema, Types, model, type HydratedDocument, type InferSchemaType } from "mongoose";

export const SECURITY_REPORT_SUBJECTS = ["settlement_account", "settlement_only_off", "two_factor"] as const;
export type SecurityReportSubject = (typeof SECURITY_REPORT_SUBJECTS)[number];

/**
 * A "This wasn't me" link in a security email. Each recipient gets their own token (only its hash is stored).
 * Using it stops the change and freezes money out until LinkPay staff have spoken to the business.
 * It works without signing in, because the person reporting may have lost their login to an attacker.
 */
const securityReportSchema = new Schema(
  {
    tokenHash: { type: String, required: true, unique: true },
    subject: { type: String, enum: SECURITY_REPORT_SUBJECTS, required: true },
    business: { type: Types.ObjectId, ref: "Business" },
    request: { type: Types.ObjectId, ref: "SecurityRequest" },
    // Who made the change being reported.
    user: { type: Types.ObjectId, ref: "User", required: true },
    // Who the link was sent to.
    email: { type: String, required: true },
    // Shown on the report page: "Settlement account Acme Trading Ltd, 0123456789 (GTBank)".
    summary: { type: String, required: true },
    usedAt: { type: Date },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

export type SecurityReport = InferSchemaType<typeof securityReportSchema>;
export type SecurityReportDocument = HydratedDocument<SecurityReport>;
export const SecurityReportModel = model("SecurityReport", securityReportSchema);
