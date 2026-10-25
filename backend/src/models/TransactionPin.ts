import { Schema, Types, model, type HydratedDocument, type InferSchemaType } from "mongoose";

/**
 * A business user's 4-digit transaction PIN, checked by the server before money moves or security settings
 * change (services/transactionPin.ts). One per user, across all their businesses. It lives apart from User so
 * the hash can never ride along in a `res.json(user)`, and so counting attempts never rewrites the user.
 * No document means the user hasn't set a PIN yet.
 */
const transactionPinSchema = new Schema(
  {
    user: { type: Types.ObjectId, ref: "User", required: true, unique: true },
    // argon2id from Bun.password. Never loaded unless asked for with select("+pinHash").
    pinHash: { type: String, required: true, select: false },
    // Wrong PINs since the last right one, the last lock ending, or the PIN being changed.
    failedAttempts: { type: Number, default: 0 },
    // Set when failedAttempts reaches the limit; the PIN can't be used until then.
    lockedUntil: Date,
    // Every wrong PIN over the last day, locks or not (a try is added before it's compared and taken back out if
    // it was right; older ones drop out at the next try). Past the daily cap the PIN locks until it's reset.
    recentFailures: { type: [{ at: { type: Date, required: true } }], default: [] },
    // Set when recentFailures reached the daily cap. No timer ends it: only a reset (password + emailed code).
    resetRequiredAt: Date,
    // When the PIN itself was last set, changed or reset.
    changedAt: { type: Date, required: true },
    lastUsedAt: Date,
  },
  {
    timestamps: true,
    toJSON: {
      transform: (_doc, ret: Record<string, any>) => {
        delete ret.pinHash;
        delete ret.recentFailures;
        delete ret.__v;
        return ret;
      },
    },
  },
);

export type TransactionPin = InferSchemaType<typeof transactionPinSchema>;
export type TransactionPinDocument = HydratedDocument<TransactionPin>;
export const TransactionPinModel = model("TransactionPin", transactionPinSchema);
