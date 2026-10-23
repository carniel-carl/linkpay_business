import { Schema, model, type InferSchemaType } from "mongoose";

export const LIST_ORDERS = ["newest_first", "oldest_first", "unordered"] as const;
export type ListOrder = (typeof LIST_ORDERS)[number];

// How far the sync of a Liquifia list has got, so each run carries on from there instead of re-reading it all
// (see services/transactions.ts). One document per list. Positions are `skip` values in that list.
const syncStateSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    // The order the list was last seen in. Liquifia doesn't document it, so every run checks.
    order: { type: String, enum: LIST_ORDERS },
    // Newest first: every row from the top of the list down to this time is recorded.
    newestAt: { type: Date },
    // Newest first: older rows still to read, from this position until rows older than `backlogUntil` (none: the end).
    backlogSkip: { type: Number },
    backlogUntil: { type: Date },
    // Oldest first: where the next run starts (a page before the end of what was read) and the id expected there.
    // Unordered: where the current full read carries on.
    resumeSkip: { type: Number },
    resumeId: { type: String },
    // Our payments still pending, or that couldn't be recorded, are read again until they settle (for a day):
    // the oldest one's time (newest first) or position (oldest first).
    unsettledAt: { type: Date },
    unsettledSkip: { type: Number },
  },
  { timestamps: true },
);

export type SyncState = InferSchemaType<typeof syncStateSchema>;
export const SyncStateModel = model("SyncState", syncStateSchema);
