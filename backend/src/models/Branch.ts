import { Schema, Types, model, type HydratedDocument, type InferSchemaType } from "mongoose";

export const ACCOUNT_STATUSES = ["not_started", "pending", "active", "failed"] as const;

const branchSchema = new Schema(
  {
    business: { type: Types.ObjectId, ref: "Business", required: true, index: true },
    name: { type: String, required: true, trim: true },
    // Created automatically on approval at the business's registered address; exactly one per business.
    isHeadOffice: { type: Boolean, default: false },
    address: {
      street: { type: String, trim: true },
      city: { type: String, trim: true },
      state: { type: String, trim: true },
      country: { type: String, default: "NG" },
    },
    // Contact details for now; becomes a link to a team member once Team is built.
    manager: {
      name: { type: String, trim: true },
      email: { type: String, lowercase: true, trim: true },
      phone: { type: String, trim: true },
    },
    // Provisioning of this branch's Liquifia virtual account. Liquifia gives one NGN account per customer,
    // so each branch other than the head office is its own customer (the head office uses the business's).
    liquifia: {
      customerId: { type: String },
      accountStatus: { type: String, enum: ACCOUNT_STATUSES, default: "not_started" },
      lastError: { type: String },
      // Reused on retries so Liquifia never issues a second account for the same branch.
      virtualAccountIdempotencyKey: { type: String },
    },
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

branchSchema.index({ business: 1, isHeadOffice: 1 }, { unique: true, partialFilterExpression: { isHeadOffice: true } });
// Branch names are unique per business, ignoring case.
branchSchema.index({ business: 1, name: 1 }, { unique: true, collation: { locale: "en", strength: 2 } });

export type Branch = InferSchemaType<typeof branchSchema>;
export type BranchDocument = HydratedDocument<Branch>;
export const BranchModel = model("Branch", branchSchema);
