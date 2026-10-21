import { Schema, Types, model, type HydratedDocument, type InferSchemaType } from "mongoose";
import { STAFF_ROLES } from "../config/staffPermissions";

export const STAFF_INVITE_STATUSES = ["pending", "accepted", "revoked"] as const;

/** An emailed invite to join the admin console with a role. Accepting it creates the Staff. */
const staffInviteSchema = new Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    role: { type: String, enum: STAFF_ROLES, required: true },
    invitedBy: { type: Types.ObjectId, ref: "Staff", required: true },
    // Only the hash is stored; the raw token lives in the emailed link.
    tokenHash: { type: String, required: true, unique: true },
    // "pending" past expiresAt counts as expired.
    status: { type: String, enum: STAFF_INVITE_STATUSES, default: "pending" },
    expiresAt: { type: Date, required: true },
    lastSentAt: { type: Date, required: true },
    acceptedAt: Date,
    acceptedStaff: { type: Types.ObjectId, ref: "Staff" },
    revokedAt: Date,
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

// One open invite per email; resend it instead of creating another.
staffInviteSchema.index({ email: 1 }, { unique: true, partialFilterExpression: { status: "pending" } });

export type StaffInvite = InferSchemaType<typeof staffInviteSchema>;
export type StaffInviteDocument = HydratedDocument<StaffInvite>;
export const StaffInviteModel = model("StaffInvite", staffInviteSchema, "staffInvites");
