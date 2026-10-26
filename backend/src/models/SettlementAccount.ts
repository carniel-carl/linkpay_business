import { Schema, Types, model, type HydratedDocument, type InferSchemaType } from "mongoose";

export const SETTLEMENT_STATUSES = [
  "pending", // waiting for staff review and the cooling-off (its SecurityRequest)
  "active", // money can be withdrawn to it
  "rejected", // staff turned it down
  "cancelled", // withdrawn by the business, or reported with "This wasn't me"
  "removed", // was active, taken off by the business (or after a report)
] as const;
export type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number];
export const OPEN_SETTLEMENT_STATUSES: SettlementStatus[] = ["pending", "active"];

/**
 * A bank account the business withdraws its money to (its own account at another bank). The account name
 * comes from a name enquiry and must match the business (or, for sole traders and partnerships, an owner or
 * partner). Usable only once a LinkPay staff member has approved it and the cooling-off has passed.
 */
const settlementAccountSchema = new Schema(
  {
    business: { type: Types.ObjectId, ref: "Business", required: true, index: true },
    accountNumber: { type: String, required: true },
    accountName: { type: String, required: true }, // as the bank reported it
    bankUuid: { type: String, required: true },
    bankName: { type: String },
    nameCheck: {
      result: { type: String, enum: ["match", "partial"], required: true },
      score: { type: Number, required: true },
      matchedTo: { type: String, enum: ["business", "person"], required: true },
      matchedName: { type: String, required: true },
      // Why a match was downgraded to partial (e.g. a director's personal account for a company).
      note: { type: String },
    },
    status: { type: String, enum: SETTLEMENT_STATUSES, required: true, default: "pending" },
    // The review that makes it active.
    request: { type: Types.ObjectId, ref: "SecurityRequest" },
    addedBy: { type: Types.ObjectId, ref: "User", required: true },
    activatedAt: { type: Date },
    endedAt: { type: Date },
    endedBy: { type: Types.ObjectId, ref: "User" },
    lastWithdrawalAt: { type: Date },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (_doc, ret: Record<string, any>) => {
        delete ret.__v;
        return ret;
      },
    },
  },
);

// One open entry per account per business.
settlementAccountSchema.index(
  { business: 1, accountNumber: 1, bankUuid: 1 },
  { unique: true, partialFilterExpression: { status: { $in: OPEN_SETTLEMENT_STATUSES } } },
);
// "Is this account someone else's settlement account too?"
settlementAccountSchema.index({ accountNumber: 1, bankUuid: 1 });

export type SettlementAccount = InferSchemaType<typeof settlementAccountSchema>;
export type SettlementAccountDocument = HydratedDocument<SettlementAccount>;
export const SettlementAccountModel = model("SettlementAccount", settlementAccountSchema);
