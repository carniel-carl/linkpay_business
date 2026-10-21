import { Schema, Types, model, type HydratedDocument, type InferSchemaType } from "mongoose";

export const TRANSACTION_STATUSES = ["pending", "success", "failed", "reversed"] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

export const TRANSACTION_TYPES = ["inbound_transfer", "payout"] as const;

// Money movements on a business's accounts, recorded from Liquifia (the source of truth for balances).
// Incoming transfers come from the inbound-transfer sync; payouts from Transfers once Liquifia accepts them.
const transactionSchema = new Schema(
  {
    business: { type: Types.ObjectId, ref: "Business", required: true },
    branch: { type: Types.ObjectId, ref: "Branch" },
    virtualAccount: { type: Types.ObjectId, ref: "VirtualAccount", required: true },
    type: { type: String, enum: TRANSACTION_TYPES, required: true },
    // The transfer a payout belongs to.
    transfer: { type: Types.ObjectId, ref: "Transfer" },
    // Incoming payments: the invoice this pays (matched from the narration or linked by hand).
    invoice: { type: Types.ObjectId, ref: "Invoice" },
    // When the invoice matcher last looked at this payment; it looks once (see services/invoices.ts).
    invoiceCheckedAt: { type: Date },
    direction: { type: String, enum: ["credit", "debit"], required: true },
    // Integers in kobo.
    amountKobo: { type: Number, required: true },
    feeKobo: { type: Number, default: 0 },
    netKobo: { type: Number, required: true },
    currency: { type: String, default: "NGN" },
    status: { type: String, enum: TRANSACTION_STATUSES, required: true },
    counterparty: {
      name: { type: String },
      bankName: { type: String },
      accountNumber: { type: String },
    },
    narration: { type: String },
    reference: { type: String },
    provider: { type: String, enum: ["liquifia"], default: "liquifia" },
    providerTransactionId: { type: String, required: true, unique: true },
    providerData: { type: Schema.Types.Mixed, select: false },
    occurredAt: { type: Date, required: true },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (_doc, ret: Record<string, any>) => {
        delete ret.providerData;
        delete ret.__v;
        return ret;
      },
    },
  },
);

transactionSchema.index({ business: 1, occurredAt: -1 });
transactionSchema.index({ branch: 1, occurredAt: -1 });
transactionSchema.index({ direction: 1, status: 1, invoiceCheckedAt: 1 });

export type Transaction = InferSchemaType<typeof transactionSchema>;
export type TransactionDocument = HydratedDocument<Transaction>;
export const TransactionModel = model("Transaction", transactionSchema);
