import { Schema, Types, model, type HydratedDocument, type InferSchemaType } from "mongoose";
import { ASSIGNABLE_ROLES } from "../config/permissions";

export const INVITE_STATUSES = ["pending", "accepted", "revoked"] as const;

const inviteSchema = new Schema(
  {
    business: { type: Types.ObjectId, ref: "Business", required: true, index: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    role: { type: String, enum: ASSIGNABLE_ROLES, required: true },
    branches: { type: [{ type: Types.ObjectId, ref: "Branch" }], default: [] },
    // Only the hash is stored; the raw token lives in the emailed link.
    tokenHash: { type: String, required: true, unique: true },
    status: { type: String, enum: INVITE_STATUSES, default: "pending" },
    expiresAt: { type: Date, required: true },
    invitedBy: { type: Types.ObjectId, ref: "User", required: true },
    lastSentAt: { type: Date, required: true },
    acceptedBy: { type: Types.ObjectId, ref: "User" },
    acceptedAt: { type: Date },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (_doc, ret: Record<string, any>) => {
        delete ret.tokenHash;
        delete ret.__v;
        return ret;
      },
    },
  },
);

// One open invite per email per business; resend it instead of creating another.
inviteSchema.index({ business: 1, email: 1 }, { unique: true, partialFilterExpression: { status: "pending" } });

export type Invite = InferSchemaType<typeof inviteSchema>;
export type InviteDocument = HydratedDocument<Invite>;
export const InviteModel = model("Invite", inviteSchema);
