import { Schema, model } from "mongoose";

export const OTP_PURPOSES = ["verify_email", "login", "two_factor", "staff_two_factor", "password_reset", "transaction_pin_reset"] as const;
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

// One per wrong code, kept for a day. Each new code starts its own attempt count, so these cap guesses across codes:
// per client address and across all of them (services/otp.ts).
const otpFailureSchema = new Schema({
  email: { type: String, required: true, lowercase: true, trim: true },
  purpose: { type: String, enum: OTP_PURPOSES, required: true },
  // A hash of the client address the wrong code came from (IPv6 grouped by /56), so no address is stored; "-" when
  // the caller gave none. Failures saved before addresses were counted have none, and count only across addresses.
  client: String,
  expiresAt: { type: Date, required: true, expires: 0 },
});

// A day's failures for one email and purpose are at most a few dozen, so this serves the per-address count too.
otpFailureSchema.index({ email: 1, purpose: 1, expiresAt: 1 });

export const OtpFailureModel = model("OtpFailure", otpFailureSchema);
