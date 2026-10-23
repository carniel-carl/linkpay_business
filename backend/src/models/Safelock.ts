import { Schema, Types, model, type HydratedDocument, type InferSchemaType } from "mongoose";

export const SAFELOCK_STATUSES = [
  "locked", // can't be touched until `unlockAt`
  "released", // the unlock day came; the money is back in the branch's available balance
] as const;
export type SafelockStatus = (typeof SAFELOCK_STATUSES)[number];

// A fixed amount locked inside a branch's account until a date. Like a pocket, nothing moves at the bank:
// the money stays in the branch's Liquifia account and our side takes it out of the available balance.
// It can't be broken early, topped up or shortened. No interest yet.
const safelockSchema = new Schema(
  {
    business: { type: Types.ObjectId, ref: "Business", required: true },
    branch: { type: Types.ObjectId, ref: "Branch", required: true },
    virtualAccount: { type: Types.ObjectId, ref: "VirtualAccount", required: true },
    title: { type: String, required: true, trim: true },
    amountKobo: { type: Number, required: true, min: 1 },
    currency: { type: String, default: "NGN" },
    unlockOn: { type: String, required: true }, // YYYY-MM-DD (Lagos)
    // Start of `unlockOn` in Lagos. From then on the money counts as available again, even before the
    // release job marks the lock released.
    unlockAt: { type: Date, required: true },
    status: { type: String, enum: SAFELOCK_STATUSES, default: "locked" },
    releasedAt: { type: Date },
    createdBy: { type: Types.ObjectId, ref: "User", required: true },
    // Optional Idempotency-Key from the client, so a retried request doesn't lock money twice.
    clientKey: { type: String },
    // Hash of what that request asked for, so the same key with different details is refused (utils/idempotency.ts).
    requestHash: { type: String },
  },
  { timestamps: true },
);

safelockSchema.index({ business: 1, status: 1, unlockAt: 1 });
safelockSchema.index({ virtualAccount: 1, status: 1, unlockAt: 1 });
safelockSchema.index({ status: 1, unlockAt: 1 });
safelockSchema.index(
  { business: 1, createdBy: 1, clientKey: 1 },
  { unique: true, partialFilterExpression: { clientKey: { $type: "string" } } },
);

export type Safelock = InferSchemaType<typeof safelockSchema>;
export type SafelockDocument = HydratedDocument<Safelock>;
export const SafelockModel = model("Safelock", safelockSchema);
