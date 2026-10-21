import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { OtpModel, type OtpPurpose } from "../models/Otp";
import { HttpError } from "../utils/HttpError";

const OTP_TTL_MS = 10 * 60 * 1000;
export const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;

const hash = (code: string) => createHash("sha256").update(code).digest("hex");

/** Issues a fresh 6-digit code, replacing any earlier one for the same email + purpose. */
export async function createOtp(email: string, purpose: OtpPurpose): Promise<string> {
  const recent = await OtpModel.findOne({
    email,
    purpose,
    createdAt: { $gt: new Date(Date.now() - RESEND_COOLDOWN_MS) },
  });
  if (recent) {
    const retryAt = new Date(recent.createdAt.getTime() + RESEND_COOLDOWN_MS).toISOString();
    throw new HttpError(429, "Please wait before requesting another code", "OTP_COOLDOWN", { retryAt });
  }

  const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
  await OtpModel.deleteMany({ email, purpose });
  await OtpModel.create({
    email,
    purpose,
    codeHash: hash(code),
    expiresAt: new Date(Date.now() + OTP_TTL_MS),
  });
  return code;
}

/** Returns true and consumes the code if it matches; counts failed attempts otherwise. */
export async function verifyOtp(email: string, purpose: OtpPurpose, code: string): Promise<boolean> {
  const otp = await OtpModel.findOne({ email, purpose });
  if (!otp || otp.expiresAt.getTime() < Date.now()) return false;

  if (otp.attempts >= MAX_ATTEMPTS) {
    await otp.deleteOne();
    return false;
  }

  const matches = timingSafeEqual(Buffer.from(hash(code)), Buffer.from(otp.codeHash));
  if (!matches) {
    otp.attempts += 1;
    await otp.save();
    return false;
  }

  await otp.deleteOne();
  return true;
}
