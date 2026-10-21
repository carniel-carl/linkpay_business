import { Schema, Types, model, type HydratedDocument, type InferSchemaType } from "mongoose";
import { FLAG_CATEGORY_KEYS, FLAG_OUTCOMES, FLAG_SEVERITIES, RISK_RULE_KEYS } from "../config/compliance";

/**
 * A concern about a business for staff to look into: raised by a staff member, or by an automatic risk rule
 * (src/config/compliance.ts). Open until a staff member resolves it as cleared or actioned. Flags are
 * internal: the business never sees them.
 */
const complianceFlagSchema = new Schema(
  {
    business: { type: Types.ObjectId, ref: "Business", required: true, index: true },
    source: { type: String, enum: ["rule", "staff"], required: true },
    // Set for rule flags.
    rule: { type: String, enum: RISK_RULE_KEYS },
    category: { type: String, enum: FLAG_CATEGORY_KEYS, required: true },
    severity: { type: String, enum: FLAG_SEVERITIES, required: true },
    summary: { type: String, required: true, trim: true },
    note: { type: String, trim: true },
    // What triggered it: payments and transfers to look at, plus the rule's figures.
    evidence: {
      transactions: { type: [{ type: Types.ObjectId, ref: "Transaction" }], default: [] },
      transfers: { type: [{ type: Types.ObjectId, ref: "Transfer" }], default: [] },
      metrics: { type: Schema.Types.Mixed, default: {} },
    },
    raisedBy: { type: Types.ObjectId, ref: "Staff" },
    status: { type: String, enum: ["open", "resolved"], default: "open", index: true },
    resolution: {
      outcome: { type: String, enum: FLAG_OUTCOMES },
      note: { type: String, trim: true },
      by: { type: Types.ObjectId, ref: "Staff" },
      at: { type: Date },
    },
  },
  {
    timestamps: true,
    minimize: false,
    toJSON: {
      transform: (_doc, ret: Record<string, any>) => {
        delete ret.__v;
        return ret;
      },
    },
  },
);

complianceFlagSchema.index({ status: 1, createdAt: -1 });
// A rule raises at most one open flag per business.
complianceFlagSchema.index(
  { business: 1, rule: 1 },
  { unique: true, partialFilterExpression: { status: "open", rule: { $type: "string" } } },
);
complianceFlagSchema.index({ business: 1, rule: 1, "resolution.at": -1 });

export type ComplianceFlag = InferSchemaType<typeof complianceFlagSchema>;
export type ComplianceFlagDocument = HydratedDocument<ComplianceFlag>;
export const ComplianceFlagModel = model("ComplianceFlag", complianceFlagSchema, "complianceFlags");
