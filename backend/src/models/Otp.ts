import { Schema, model } from "mongoose";

export const OTP_PURPOSES = ["verify_email", "login", "two_factor"] as const;
export type OtpPurpose = (typeof OTP_PURPOSES)[number];

const otpSchema = new Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    purpose: { type: String, enum: OTP_PURPOSES, required: true },
    codeHash: { type: String, required: true },
    attempts: { type: Number, default: 0 },
    // MongoDB's TTL monitor deletes the document once this time passes.
    expiresAt: { type: Date, required: true, expires: 0 },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

otpSchema.index({ email: 1, purpose: 1 });

export const OtpModel = model("Otp", otpSchema);
