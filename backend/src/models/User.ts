import { Schema, model, type HydratedDocument, type InferSchemaType } from "mongoose";

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true, select: false },
    emailVerified: { type: Boolean, default: false },
    // "admin" = platform staff who review business verification. Grant with scripts/make-admin.ts.
    role: { type: String, enum: ["user", "admin"], default: "user" },
    twoFactor: {
      enabled: { type: Boolean, default: false },
      method: { type: String, enum: ["totp", "email", null], default: null },
      totpSecret: { type: String, select: false },
      // Holds the secret between /2fa/totp/setup and /2fa/totp/enable.
      pendingTotpSecret: { type: String, select: false },
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
        }
        return ret;
      },
    },
  },
);

export type User = InferSchemaType<typeof userSchema>;
export type UserDocument = HydratedDocument<User>;
export const UserModel = model("User", userSchema);
