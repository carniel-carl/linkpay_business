import { Schema, Types, model, type HydratedDocument, type InferSchemaType } from "mongoose";

// A saved bulk payout ("Monthly salaries"): beneficiaries with an amount each. Running it creates an ordinary
// bulk transfer (a TransferBatch), so the approval rules apply as usual.
const payoutListSchema = new Schema(
  {
    business: { type: Types.ObjectId, ref: "Business", required: true },
    title: { type: String, required: true, trim: true },
    // The account it's usually paid from; can be changed per run. Empty: chosen when it's run.
    branch: { type: Types.ObjectId, ref: "Branch" },
    items: [
      {
        _id: false,
        beneficiary: { type: Types.ObjectId, ref: "Beneficiary", required: true },
        amountKobo: { type: Number, required: true, min: 100 },
        narration: { type: String, trim: true },
      },
    ],
    createdBy: { type: Types.ObjectId, ref: "User", required: true },
    // The last run: its batch, or its one transfer when it paid a single person (a single row isn't a batch).
    lastRunAt: { type: Date },
    lastBatch: { type: Types.ObjectId, ref: "TransferBatch" },
    lastTransfer: { type: Types.ObjectId, ref: "Transfer" },
    // Optional Idempotency-Key from the client, so a retried create doesn't save the list twice.
    clientKey: { type: String },
    // Hash of what that request asked for, so the same key with different details is refused (utils/idempotency.ts).
    requestHash: { type: String },
  },
  { timestamps: true },
);

payoutListSchema.index({ business: 1, updatedAt: -1 });
payoutListSchema.index({ "items.beneficiary": 1 });
payoutListSchema.index(
  { business: 1, createdBy: 1, clientKey: 1 },
  { unique: true, partialFilterExpression: { clientKey: { $type: "string" } } },
);

export type PayoutList = InferSchemaType<typeof payoutListSchema>;
export type PayoutListDocument = HydratedDocument<PayoutList>;
export const PayoutListModel = model("PayoutList", payoutListSchema);
