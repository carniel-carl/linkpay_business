import { Schema, Types, model, type HydratedDocument, type InferSchemaType } from "mongoose";

export const TRANSFER_KINDS = [
  "bank", // to any Nigerian bank account
  "internal", // to another branch of the same business
  "linkpay", // to another business's LinkPay account
] as const;
export type TransferKind = (typeof TRANSFER_KINDS)[number];

export const TRANSFER_STATUSES = [
  "pending_approval", // money is held on the source account until someone approves or rejects it
  "rejected",
  "cancelled", // withdrawn by the person who created it before approval
  "processing", // approved and handed to Liquifia (or about to be: see provider.payoutId)
  "success",
  "failed",
] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];

/** Statuses whose amount still counts against the source account's available balance on our side. */
export const OPEN_TRANSFER_STATUSES: TransferStatus[] = ["pending_approval", "processing"];

// Money sent out of a branch's account through a Liquifia payout. Liquifia stays the source of truth for
// balances; a transfer holds its total (amount + fee) on our side until it succeeds or fails (see heldByAccount).
const transferSchema = new Schema(
  {
    business: { type: Types.ObjectId, ref: "Business", required: true },
    branch: { type: Types.ObjectId, ref: "Branch", required: true },
    virtualAccount: { type: Types.ObjectId, ref: "VirtualAccount", required: true },
    batch: { type: Types.ObjectId, ref: "TransferBatch" },
    kind: { type: String, enum: TRANSFER_KINDS, required: true },

    // Integers in kobo. The recipient gets `amountKobo`; the account is debited `totalKobo`.
    amountKobo: { type: Number, required: true, min: 100 },
    feeKobo: { type: Number, required: true, min: 0 }, // Liquifia's fee, including stamp duty
    stampDutyKobo: { type: Number, default: 0 },
    totalKobo: { type: Number, required: true },
    currency: { type: String, default: "NGN" },

    recipient: {
      accountNumber: { type: String, required: true },
      accountName: { type: String, required: true },
      bankName: { type: String },
      bankUuid: { type: String, required: true },
      // Set for internal and LinkPay transfers.
      business: { type: Types.ObjectId, ref: "Business" },
      branch: { type: Types.ObjectId, ref: "Branch" },
      // The saved beneficiary it was paid to, if any.
      beneficiary: { type: Types.ObjectId, ref: "Beneficiary" },
    },
    narration: { type: String, trim: true },
    // Ours, unique, sent to Liquifia as the payout reference (shown to support and on receipts).
    reference: { type: String, required: true, unique: true },

    status: { type: String, enum: TRANSFER_STATUSES, required: true },
    failureReason: { type: String },
    createdBy: { type: Types.ObjectId, ref: "User", required: true },
    // Optional key from the client (Idempotency-Key header) so a retried request doesn't send twice.
    clientKey: { type: String },
    // Hash of what that request asked for, so the same key with different details is refused (utils/idempotency.ts).
    requestHash: { type: String },
    // The final approval or the rejection.
    decision: {
      by: { type: Types.ObjectId, ref: "User" },
      at: { type: Date },
      note: { type: String, trim: true },
    },
    // The approval levels this transfer needs, fixed when it's created so later rule changes don't apply.
    // Empty when it needed none (and on transfers from before levels, which had one "any approver" level).
    approval: {
      levels: [
        {
          _id: false,
          // Anyone who can approve transfers clears it (the simple rules); otherwise one of `approvers`.
          any: { type: Boolean, default: false },
          approvers: [{ type: Types.ObjectId, ref: "User" }],
          approvedBy: { type: Types.ObjectId, ref: "User" },
          approvedAt: { type: Date },
          note: { type: String, trim: true },
        },
      ],
      // Index of the level waiting for a decision; equals levels.length once fully approved.
      current: { type: Number, default: 0 },
      // The current level's approvers (or `waitingOnAny`), so "waiting for me" is one query.
      waitingOn: [{ type: Types.ObjectId, ref: "User" }],
      waitingOnAny: { type: Boolean, default: false },
    },

    provider: {
      // Sent with every create attempt so a retry after a timeout can't pay twice.
      idempotencyKey: { type: String, required: true },
      // Set once Liquifia has accepted the payout; until then the transfer is retried.
      payoutId: { type: String },
      status: { type: String },
      attempts: { type: Number, default: 0 },
      // When the first create was sent; from the second attempt on, the payout is looked up before sending again.
      firstAttemptAt: { type: Date },
      // Set while one caller is sending the payout, so the sweep, webhooks and /refresh can't send it at the same time.
      submittingUntil: { type: Date },
      // When staff were told it's taking too long or Liquifia reported a status we don't know (once).
      stuckAt: { type: Date },
      lastError: { type: String },
      lastCheckedAt: { type: Date },
      data: { type: Schema.Types.Mixed, select: false },
    },
    submittedAt: { type: Date },
    completedAt: { type: Date },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (_doc, ret: Record<string, any>) => {
        delete ret.__v;
        delete ret.clientKey;
        delete ret.requestHash;
        if (ret.provider) ret.provider = { status: ret.provider.status };
        return ret;
      },
    },
  },
);

transferSchema.index({ business: 1, createdAt: -1 });
// Risk checks over recent transfers across every business.
transferSchema.index({ createdAt: -1 });
transferSchema.index({ virtualAccount: 1, status: 1 });
transferSchema.index({ status: 1, "provider.lastCheckedAt": 1 });
// Payout webhooks find their transfer by Liquifia's payout id.
transferSchema.index({ "provider.payoutId": 1 }, { sparse: true });
transferSchema.index({ batch: 1 });
transferSchema.index({ "recipient.beneficiary": 1, createdAt: -1 });
transferSchema.index({ business: 1, status: 1, "approval.waitingOn": 1 });
// A member's 24-hour total from a branch, which decides whether their next transfer needs approval.
transferSchema.index({ createdBy: 1, branch: 1, createdAt: -1 });
transferSchema.index(
  { business: 1, createdBy: 1, clientKey: 1 },
  { unique: true, partialFilterExpression: { clientKey: { $type: "string" } } },
);

export type Transfer = InferSchemaType<typeof transferSchema>;
export type TransferDocument = HydratedDocument<Transfer>;
export const TransferModel = model("Transfer", transferSchema);

// Several transfers from one account, created, approved and rejected together.
const transferBatchSchema = new Schema(
  {
    business: { type: Types.ObjectId, ref: "Business", required: true, index: true },
    branch: { type: Types.ObjectId, ref: "Branch", required: true },
    title: { type: String, trim: true },
    // The saved payout list it was run from, if any.
    payoutList: { type: Types.ObjectId, ref: "PayoutList" },
    createdBy: { type: Types.ObjectId, ref: "User", required: true },
    count: { type: Number, required: true },
    amountKobo: { type: Number, required: true },
    feeKobo: { type: Number, required: true },
    totalKobo: { type: Number, required: true },
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

export type TransferBatch = InferSchemaType<typeof transferBatchSchema>;
export const TransferBatchModel = model("TransferBatch", transferBatchSchema);
