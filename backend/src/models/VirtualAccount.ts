import { Schema, Types, model, type InferSchemaType } from "mongoose";

const virtualAccountSchema = new Schema(
  {
    business: { type: Types.ObjectId, ref: "Business", required: true, index: true },
    // One account per branch. Accounts created before branches existed get it from scripts/migrate-branches.ts.
    branch: { type: Types.ObjectId, ref: "Branch", index: { unique: true, sparse: true } },
    label: { type: String, default: "Main account" },
    provider: { type: String, enum: ["liquifia"], default: "liquifia" },
    providerAccountId: { type: String, required: true, unique: true },
    providerCustomerId: { type: String, required: true },
    accountNumber: { type: String, required: true },
    accountName: { type: String },
    bankName: { type: String },
    currency: { type: String, default: "NGN" },
    status: { type: String, default: "active" },
    // Liquifia's id for this account's bank (from /banks), found by name the first time money is sent here.
    bankUuid: { type: String },
    // Short lock while a transfer from this account checks the balance and holds funds (see services/transfers.ts).
    lockedUntil: { type: Date, select: false },
    // Random token of whoever holds the lock, so only the holder can extend or release it.
    lockToken: { type: String, select: false },
    // Raw provider response, kept for support and reconciliation.
    providerData: { type: Schema.Types.Mixed, select: false },
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

export type VirtualAccount = InferSchemaType<typeof virtualAccountSchema>;
export const VirtualAccountModel = model("VirtualAccount", virtualAccountSchema);
