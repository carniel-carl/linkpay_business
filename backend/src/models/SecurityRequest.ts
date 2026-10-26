import { Schema, Types, model, type HydratedDocument, type InferSchemaType } from "mongoose";

export const SECURITY_REQUEST_KINDS = [
  "settlement_account", // add a settlement account
  "settlement_only_off", // turn off "settlement accounts only"
] as const;
export type SecurityRequestKind = (typeof SECURITY_REQUEST_KINDS)[number];

export const SECURITY_REQUEST_STATUSES = [
  "pending", // waiting for a staff decision (the cooling-off runs at the same time)
  "approved", // staff approved; takes effect at `availableAt`
  "completed", // in effect
  "rejected", // staff turned it down
  "cancelled", // withdrawn by the business, a "This wasn't me" report, or staff freezing money out
] as const;
export type SecurityRequestStatus = (typeof SECURITY_REQUEST_STATUSES)[number];
export const OPEN_REQUEST_STATUSES: SecurityRequestStatus[] = ["pending", "approved"];

/**
 * A change that loosens where money can go. It needs both a LinkPay staff approval (with a call back to the
 * business on a number from its verification) and a cooling-off, so a stolen login alone can't do it and
 * the real team has time to notice the emails and stop it.
 */
const securityRequestSchema = new Schema(
  {
    business: { type: Types.ObjectId, ref: "Business", required: true, index: true },
    kind: { type: String, enum: SECURITY_REQUEST_KINDS, required: true },
    settlementAccount: { type: Types.ObjectId, ref: "SettlementAccount" },
    status: { type: String, enum: SECURITY_REQUEST_STATUSES, required: true, default: "pending" },
    requestedBy: { type: Types.ObjectId, ref: "User", required: true },
    // Where it was asked from, for the reviewer.
    ip: { type: String },
    userAgent: { type: String },
    // End of the cooling-off: it can't take effect before this, whatever staff decide.
    availableAt: { type: Date, required: true },
    // What the reviewer sees: name check, the requester's recent security changes, the account's other uses...
    signals: { type: Schema.Types.Mixed, default: {} },
    review: {
      decision: { type: String, enum: ["approved", "rejected"] },
      by: { type: Types.ObjectId, ref: "Staff" },
      byName: { type: String },
      at: { type: Date },
      note: { type: String, trim: true },
      // The reviewer called the business back on a number from its verification and it confirmed the change.
      callbackConfirmed: { type: Boolean },
    },
    cancellation: {
      by: { type: String, enum: ["member", "report", "staff"] },
      byId: { type: Types.ObjectId },
      byName: { type: String },
      at: { type: Date },
      reason: { type: String, trim: true },
    },
    completedAt: { type: Date },
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

securityRequestSchema.index({ status: 1, availableAt: 1 });
securityRequestSchema.index({ status: 1, createdAt: 1 });
// One open request of each kind per settlement account / business.
securityRequestSchema.index(
  { business: 1, kind: 1 },
  { unique: true, partialFilterExpression: { kind: "settlement_only_off", status: { $in: OPEN_REQUEST_STATUSES } } },
);

export type SecurityRequest = InferSchemaType<typeof securityRequestSchema>;
export type SecurityRequestDocument = HydratedDocument<SecurityRequest>;
export const SecurityRequestModel = model("SecurityRequest", securityRequestSchema);
