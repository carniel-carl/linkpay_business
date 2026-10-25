import { Schema, Types, model, type InferSchemaType } from "mongoose";

// An account's balance as Liquifia reported it at the start of a Lagos day, taken by the balance-snapshot job
// (services/balanceSnapshots.ts). Statements show it as an opening or closing balance only when it was taken
// close enough to 00:00 WAT (docs/briefs/statements.md). Written once, never changed: a balance shown is one
// the bank reported, at the time recorded here.
const balanceSnapshotSchema = new Schema(
  {
    business: { type: Types.ObjectId, ref: "Business", required: true },
    // The account's branch when the snapshot was taken (none for an account from before branches).
    branch: { type: Types.ObjectId, ref: "Branch" },
    virtualAccount: { type: Types.ObjectId, ref: "VirtualAccount", required: true },
    // "YYYY-MM-DD": the Lagos day this balance opens.
    day: { type: String, required: true },
    // Integer kobo, as Liquifia's GET /virtual-accounts/:id/balance reported it.
    balanceKobo: { type: Number, required: true },
    // When Liquifia's answer arrived. A snapshot taken late keeps its real time; statements then leave it out.
    takenAt: { type: Date, required: true },
  },
  { versionKey: false },
);

// One per account per day. The job writes with an insert-only upsert on this key, so overlapping runs (or two
// instances) can't record a day twice. It also serves the statement's lookups (an account's days, its first day).
balanceSnapshotSchema.index({ virtualAccount: 1, day: 1 }, { unique: true });

export type BalanceSnapshot = InferSchemaType<typeof balanceSnapshotSchema>;
export const BalanceSnapshotModel = model("BalanceSnapshot", balanceSnapshotSchema);
