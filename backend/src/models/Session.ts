import { Schema, Types, model, type HydratedDocument, type InferSchemaType } from "mongoose";

export const DEVICE_PLATFORMS = ["ios", "android", "web", "other"] as const;

/**
 * A signed-in device. Clients that send `device` when signing in (the mobile app) get a short-lived
 * access token tied to one of these plus a rotating refresh token, so the session can be listed and
 * revoked. Only hashes of refresh tokens are stored.
 */
const sessionSchema = new Schema(
  {
    user: { type: Types.ObjectId, ref: "User", required: true, index: true },
    refreshTokenHash: { type: String, required: true, unique: true },
    // The token this one replaced, accepted once more for a short grace period in case the client
    // never received the rotated pair (a dropped response).
    previousTokenHash: { type: String, index: true, sparse: true },
    rotatedAt: Date,
    // Older tokens of this session. Presenting one means a copy of the token was taken: the session is revoked.
    retiredTokenHashes: { type: [String], index: true, default: [] },
    // Random id the app keeps for as long as it's installed. Links the phone's sessions to its biometric sign-in key.
    installationId: { type: String, index: true },
    device: {
      name: { type: String, required: true, trim: true },
      platform: { type: String, enum: DEVICE_PLATFORMS, required: true },
      model: { type: String, trim: true },
      osVersion: { type: String, trim: true },
      appVersion: { type: String, trim: true },
    },
    ip: String,
    userAgent: String,
    lastUsedAt: { type: Date, default: () => new Date() },
    // Sliding idle expiry, capped by absoluteExpiresAt. MongoDB's TTL monitor deletes the document once it passes.
    expiresAt: { type: Date, required: true, expires: 0 },
    absoluteExpiresAt: { type: Date, required: true },
    revokedAt: Date,
    revokedReason: { type: String, enum: ["signed_out", "revoked", "reuse_detected", "signed_out_everywhere"] },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    toJSON: {
      transform: (_doc, ret: Record<string, any>) => {
        delete ret.refreshTokenHash;
        delete ret.previousTokenHash;
        delete ret.retiredTokenHashes;
        delete ret.__v;
        return ret;
      },
    },
  },
);

export type Session = InferSchemaType<typeof sessionSchema>;
export type SessionDocument = HydratedDocument<Session>;
export const SessionModel = model("Session", sessionSchema);
