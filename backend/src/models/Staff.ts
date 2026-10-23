import { Schema, Types, model, type HydratedDocument, type InferSchemaType } from "mongoose";
import { STAFF_ROLES } from "../config/staffPermissions";

export const STAFF_STATUSES = ["active", "disabled"] as const;
export const STAFF_TWO_FACTOR_METHODS = ["email", "totp"] as const;

/**
 * LinkPay staff who use the admin console (KYB review, account setup). A separate identity from
 * business `User`s: staff can't sign in to the business apps and users can't sign in to admin.
 * The first one is added with scripts/staff.ts; after that super admins invite the rest (StaffInvite).
 * Two-step sign-in is mandatory; only the method can change. `role` sets the permissions
 * (src/config/staffPermissions.ts) and is read fresh on every request.
 */
const staffSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true, select: false },
    role: { type: String, enum: STAFF_ROLES, required: true },
    status: { type: String, enum: STAFF_STATUSES, default: "active" },
    invitedBy: { type: Types.ObjectId, ref: "Staff" },
    lastSignInAt: Date,
    twoFactor: {
      method: { type: String, enum: STAFF_TWO_FACTOR_METHODS, default: "email" },
      totpSecret: { type: String, select: false },
      // Holds the secret between /2fa/totp/setup and /2fa/totp/enable.
      pendingTotpSecret: { type: String, select: false },
      // The 30-second step of the last authenticator code accepted. That step and earlier ones aren't accepted again.
      totpLastStep: { type: Number, select: false },
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (_doc, ret: Record<string, any>) => {
        delete ret.password;
        delete ret.__v;
        if (ret.twoFactor) {
          delete ret.twoFactor.totpSecret;
          delete ret.twoFactor.pendingTotpSecret;
          delete ret.twoFactor.totpLastStep;
        }
        return ret;
      },
    },
  },
);

export type Staff = InferSchemaType<typeof staffSchema>;
export type StaffDocument = HydratedDocument<Staff>;
export const StaffModel = model("Staff", staffSchema, "staff");
