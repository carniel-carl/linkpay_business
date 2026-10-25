import { Schema, model, type HydratedDocument, type InferSchemaType } from "mongoose";

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    // Absent when verification removed a password chosen before the email was proven (services/passwords.ts).
    // The owner sets one with a password reset.
    password: { type: String, select: false },
    // Whether `password` is set, for clients (the hash is never sent). Older accounts all have one.
    hasPassword: { type: Boolean, default: true },
    // The last password change or reset. Every session carries the value it signed in under, and one signed in
    // before the latest change can't be used (services/sessions.ts): a sign-in that checked the old password
    // just before a reset can't open a session after it. Absent until the first change.
    passwordChangedAt: { type: Date },
    emailVerified: { type: Boolean, default: false },
    // Until the email is verified: proves who chose the password. Only the sign-up's own client has the token.
    registration: {
      tokenHash: { type: String, select: false },
      expiresAt: { type: Date, select: false },
    },
    // Last "you already have an account" email, so signing up again with a used email can't flood the inbox.
    signUpNoticeAt: { type: Date, select: false },
    // Set on every sign-in (web and mobile), so staff can see who is active on a business.
    lastSignInAt: { type: Date },
    lastSignInIp: { type: String },
    twoFactor: {
      enabled: { type: Boolean, default: false },
      method: { type: String, enum: ["totp", "email", null], default: null },
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
        delete ret.registration;
        delete ret.signUpNoticeAt;
        delete ret.passwordChangedAt;
        delete ret.__v;
        // Older documents carry a staff `role` until scripts/migrate-staff.ts unsets it.
        delete ret.role;
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

export type User = InferSchemaType<typeof userSchema>;
export type UserDocument = HydratedDocument<User>;
export const UserModel = model("User", userSchema);
