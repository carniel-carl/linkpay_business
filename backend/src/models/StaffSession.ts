import { Schema, Types, model, type HydratedDocument, type InferSchemaType } from "mongoose";

/**
 * A staff sign-in to the admin console. Ends after 12 hours, after 60 minutes without a request,
 * on sign-out, or when the staff member changes their password or is signed out by scripts/staff.ts.
 */
const staffSessionSchema = new Schema(
  {
    staff: { type: Types.ObjectId, ref: "Staff", required: true, index: true },
    // The staff member's passwordChangedAt as it was when this session signed in (none if the password had never
    // changed). Once theirs is later, the session is refused (services/staffAuth.ts).
    passwordChangedAt: Date,
    lastUsedAt: { type: Date, default: () => new Date() },
    // Absolute expiry; also the access token's `exp`. MongoDB's TTL monitor deletes the document once it passes.
    expiresAt: { type: Date, required: true, expires: 0 },
    revokedAt: Date,
    ip: String,
    userAgent: String,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

export type StaffSession = InferSchemaType<typeof staffSessionSchema>;
export type StaffSessionDocument = HydratedDocument<StaffSession>;
export const StaffSessionModel = model("StaffSession", staffSessionSchema);
