import { Schema, model, type HydratedDocument, type InferSchemaType } from "mongoose";

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true, select: false },
    emailVerified: { type: Boolean, default: false },
    // Set on every sign-in (web and mobile), so staff can see who is active on a business.
    lastSignInAt: { type: Date },
    lastSignInIp: { type: String },
    twoFactor: {
      enabled: { type: Boolean, default: false },
      method: { type: String, enum: ["totp", "email", null], default: null },
      totpSecret: { type: String, select: false },
      // Holds the secret between /2fa/totp/setup and /2fa/totp/enable.
      pendingTotpSecret: { type: String, select: false },
    },
    // Money-out protection (services/moneyOut.ts, services/stepUp.ts).
    security: {
      // No moving money until then (after a two-step change). `null` with a reason "reported" = until staff clear it.
      holdUntil: { type: Date },
      holdReason: { type: String, enum: ["two_factor_changed", "reported", null] },
      holdIndefinite: { type: Boolean, default: false },
      // Too many wrong step-up codes.
      lockedUntil: { type: Date },
      // Last authenticator time-step accepted for a step-up, so a code can't be used twice.
      totpLastCounter: { type: Number, select: false },
      // Every token issued before this is refused (signed out everywhere, web included).
      sessionsValidAfter: { type: Date },
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (_doc, ret: Record<string, any>) => {
        delete ret.password;
        delete ret.__v;
        // Older documents carry a staff `role` until scripts/migrate-staff.ts unsets it.
        delete ret.role;
        if (ret.twoFactor) {
          delete ret.twoFactor.totpSecret;
          delete ret.twoFactor.pendingTotpSecret;
        }
        if (ret.security) delete ret.security.totpLastCounter;
        return ret;
      },
    },
  },
);

export type User = InferSchemaType<typeof userSchema>;
export type UserDocument = HydratedDocument<User>;
export const UserModel = model("User", userSchema);
