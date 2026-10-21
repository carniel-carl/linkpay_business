import { Schema, Types, model, type HydratedDocument, type InferSchemaType } from "mongoose";

/** Colours the apps can show a pocket in. The apps map each key to their own palette. */
export const POCKET_COLORS = ["lime", "green", "teal", "blue", "violet", "pink", "orange", "amber", "slate"] as const;
/** Icons the apps can show on a pocket's tile. Each app maps a key to its own icon set; no icon shows a savings glyph. */
export const POCKET_ICONS = [
  "savings", "tax", "payroll", "rent", "shop", "stock", "delivery", "power", "repairs", "equipment",
  "vehicle", "travel", "marketing", "growth", "emergency", "loan", "training", "health", "events", "goal",
] as const;
export const POCKET_STATUSES = ["active", "closed"] as const;

// A named pot of money inside a branch's account ("Tax", "Payroll"). Nothing moves at the bank: the money
// stays in the branch's Liquifia account, and our side takes it out of the available balance, so transfers
// can't spend it. `balanceKobo` is the running total of the pocket's movements.
const pocketSchema = new Schema(
  {
    business: { type: Types.ObjectId, ref: "Business", required: true },
    branch: { type: Types.ObjectId, ref: "Branch", required: true },
    virtualAccount: { type: Types.ObjectId, ref: "VirtualAccount", required: true },
    name: { type: String, required: true, trim: true },
    icon: { type: String, enum: POCKET_ICONS },
    color: { type: String, enum: POCKET_COLORS, default: "lime" },
    // Integer kobo, never negative.
    balanceKobo: { type: Number, required: true, default: 0, min: 0 },
    target: {
      amountKobo: { type: Number },
      date: { type: String }, // YYYY-MM-DD (Lagos)
      // When the balance first reached the target amount; cleared if it drops below again.
      reachedAt: { type: Date },
    },
    // Keeps part of every incoming payment to the branch's account. One of the two amounts is set.
    autoSave: {
      percentBps: { type: Number }, // 1000 = 10%
      amountKobo: { type: Number },
      // Only payments that arrive after this are saved.
      since: { type: Date },
    },
    status: { type: String, enum: POCKET_STATUSES, default: "active" },
    createdBy: { type: Types.ObjectId, ref: "User", required: true },
    closedAt: { type: Date },
    closedBy: { type: Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

pocketSchema.index({ business: 1, status: 1, createdAt: 1 });
pocketSchema.index({ virtualAccount: 1, status: 1 });
// Names are unique per branch among open pockets, ignoring case.
pocketSchema.index(
  { branch: 1, name: 1 },
  { unique: true, partialFilterExpression: { status: "active" }, collation: { locale: "en", strength: 2 } },
);

export type Pocket = InferSchemaType<typeof pocketSchema>;
export type PocketDocument = HydratedDocument<Pocket>;
export const PocketModel = model("Pocket", pocketSchema);

export const POCKET_MOVEMENT_KINDS = [
  "deposit", // moved in by a team member
  "withdrawal", // moved back to the available balance by a team member
  "auto_save", // part of an incoming payment, from the pocket's auto-save rule
  "close", // everything left moved back when the pocket was closed
] as const;
export type PocketMovementKind = (typeof POCKET_MOVEMENT_KINDS)[number];

// The pocket's ledger. Money only ever moves between the pocket and its branch's available balance.
const pocketMovementSchema = new Schema(
  {
    pocket: { type: Types.ObjectId, ref: "Pocket", required: true },
    business: { type: Types.ObjectId, ref: "Business", required: true },
    kind: { type: String, enum: POCKET_MOVEMENT_KINDS, required: true },
    direction: { type: String, enum: ["in", "out"], required: true },
    amountKobo: { type: Number, required: true, min: 1 },
    balanceAfterKobo: { type: Number, required: true },
    note: { type: String, trim: true },
    // The incoming payment an auto-save came from.
    transaction: { type: Types.ObjectId, ref: "Transaction" },
    createdBy: { type: Types.ObjectId, ref: "User" }, // empty for auto-saves
    // Optional Idempotency-Key from the client, so a retried request doesn't move money twice.
    clientKey: { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

pocketMovementSchema.index({ pocket: 1, _id: -1 });
pocketMovementSchema.index(
  { pocket: 1, transaction: 1 },
  { unique: true, partialFilterExpression: { transaction: { $type: "objectId" } } },
);
pocketMovementSchema.index(
  { pocket: 1, createdBy: 1, clientKey: 1 },
  { unique: true, partialFilterExpression: { clientKey: { $type: "string" } } },
);

export type PocketMovement = InferSchemaType<typeof pocketMovementSchema>;
export type PocketMovementDocument = HydratedDocument<PocketMovement>;
export const PocketMovementModel = model("PocketMovement", pocketMovementSchema);
