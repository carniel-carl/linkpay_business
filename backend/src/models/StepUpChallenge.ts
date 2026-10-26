import { Schema, Types, model, type HydratedDocument, type InferSchemaType } from "mongoose";
import { STEP_UP_ACTIONS } from "../config/security";

/**
 * One step-up (transaction signing): a fresh second-factor code tied to one action and its exact details.
 * `payloadHash` covers the action, business, person and details, so a code can't be used for a different
 * amount or recipient. Used once; a failed action releases it so the same request can be retried.
 */
const stepUpChallengeSchema = new Schema(
  {
    user: { type: Types.ObjectId, ref: "User", required: true, index: true },
    business: { type: Types.ObjectId, ref: "Business", required: true },
    action: { type: String, enum: STEP_UP_ACTIONS, required: true },
    payloadHash: { type: String, required: true },
    // What the person was shown (and emailed): "Send ₦50,000.00 to 0123456789 (GTBank) from Head office".
    summary: { type: String, required: true },
    method: { type: String, enum: ["totp", "email"], required: true },
    // Email method only.
    codeHash: { type: String },
    attempts: { type: Number, default: 0 },
    // Set once the right code was given (a released challenge can be retried with the same code).
    verifiedCodeHash: { type: String },
    usedAt: { type: Date },
    // MongoDB's TTL monitor removes it a day after it expires (kept briefly for support).
    expiresAt: { type: Date, required: true },
    purgeAt: { type: Date, required: true, expires: 0 },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

stepUpChallengeSchema.index({ user: 1, createdAt: -1 });

export type StepUpChallenge = InferSchemaType<typeof stepUpChallengeSchema>;
export type StepUpChallengeDocument = HydratedDocument<StepUpChallenge>;
export const StepUpChallengeModel = model("StepUpChallenge", stepUpChallengeSchema);
