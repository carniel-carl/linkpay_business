import { Schema, Types, model, type HydratedDocument, type InferSchemaType } from "mongoose";
import { DEVICE_PLATFORMS } from "./Session";

export const BIOMETRIC_REVOKE_REASONS = [
  "disabled",
  "replaced",
  "forgotten",
  "device_signed_out",
  "signed_out_everywhere",
  "reuse_detected",
] as const;

/**
 * Lets one phone sign back in with Face ID or a fingerprint after its session ended. The secret sits
 * in the phone's keychain behind the biometrics enrolled when it was turned on; only its hash is
 * stored here. One live key per user and installation.
 */
const biometricKeySchema = new Schema(
  {
    user: { type: Types.ObjectId, ref: "User", required: true, index: true },
    installationId: { type: String, required: true },
    secretHash: { type: String, required: true, unique: true },
    device: {
      name: { type: String, required: true, trim: true },
      platform: { type: String, enum: DEVICE_PLATFORMS, required: true },
    },
    lastUsedAt: Date,
    // Sliding idle expiry, capped by absoluteExpiresAt. MongoDB's TTL monitor deletes the document once it passes.
    expiresAt: { type: Date, required: true, expires: 0 },
    absoluteExpiresAt: { type: Date, required: true },
    revokedAt: Date,
    revokedReason: { type: String, enum: BIOMETRIC_REVOKE_REASONS },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

biometricKeySchema.index({ user: 1, installationId: 1 });

export type BiometricKey = InferSchemaType<typeof biometricKeySchema>;
export type BiometricKeyDocument = HydratedDocument<BiometricKey>;
export type BiometricRevokeReason = (typeof BIOMETRIC_REVOKE_REASONS)[number];
export const BiometricKeyModel = model("BiometricKey", biometricKeySchema);
