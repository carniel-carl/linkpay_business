import { Schema, Types, model, type HydratedDocument, type InferSchemaType } from "mongoose";
import { BUSINESS_TYPES, ID_TYPES, PERSON_ROLES } from "../config/kyb";

export const BUSINESS_STATUSES = [
  "draft", // owner is filling in details
  "submitted", // waiting for review
  "changes_requested", // reviewer sent it back; owner can edit and resubmit
  "approved",
  "rejected",
] as const;
export type BusinessStatus = (typeof BUSINESS_STATUSES)[number];

const personSchema = new Schema(
  {
    fullName: { type: String, required: true, trim: true },
    roles: { type: [{ type: String, enum: PERSON_ROLES }], required: true },
    email: { type: String, lowercase: true, trim: true },
    phone: { type: String, trim: true },
    ownershipPercent: { type: Number, min: 0, max: 100 },
    idType: { type: String, enum: ID_TYPES },
    // BVN is encrypted at rest; only the last 4 digits are ever returned.
    bvnEncrypted: { type: String },
    bvnLast4: { type: String },
  },
  {
    toJSON: {
      transform: (_doc, ret: Record<string, any>) => {
        delete ret.bvnEncrypted;
        return ret;
      },
    },
  },
);

const businessSchema = new Schema(
  {
    // One business per user account for now (a user registers another business with another email).
    owner: { type: Types.ObjectId, ref: "User", required: true, unique: true },
    name: { type: String, required: true, trim: true },
    type: { type: String, enum: BUSINESS_TYPES, required: true },
    registrationNumber: { type: String, trim: true }, // RC / BN number
    tin: { type: String, trim: true },
    industry: { type: String, trim: true },
    description: { type: String, trim: true },
    email: { type: String, lowercase: true, trim: true },
    phone: { type: String, trim: true },
    website: { type: String, trim: true },
    address: {
      street: { type: String, trim: true },
      city: { type: String, trim: true },
      state: { type: String, trim: true },
      country: { type: String, default: "NG" },
    },
    people: { type: [personSchema], default: [] },

    status: { type: String, enum: BUSINESS_STATUSES, default: "draft", index: true },
    reviewNote: { type: String },
    submittedAt: { type: Date },
    reviewedAt: { type: Date },
    reviewedBy: { type: Types.ObjectId, ref: "User" },

    // The business's Liquifia customer, started on approval. accountStatus/lastError mirror the head
    // office branch's account (see Branch.liquifia), which is what clients show as "your account".
    liquifia: {
      customerId: { type: String },
      accountStatus: {
        type: String,
        enum: ["not_started", "pending", "active", "failed"],
        default: "not_started",
      },
      lastError: { type: String },
      // Legacy: now kept on each Branch. Copied to the head office for businesses approved before branches.
      virtualAccountIdempotencyKey: { type: String },
    },

    // When a second person must approve a transfer before money leaves. Transfers created by someone
    // without `transfers.approve` always need approval, whatever this says.
    transferApproval: {
      mode: { type: String, enum: ["never", "always", "above_threshold"], default: "never" },
      thresholdKobo: { type: Number, min: 0 },
    },
  },
  { timestamps: true },
);

export type Business = InferSchemaType<typeof businessSchema>;
export type BusinessDocument = HydratedDocument<Business>;
export const BusinessModel = model("Business", businessSchema);
