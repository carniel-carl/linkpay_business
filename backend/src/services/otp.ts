import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { OtpFailureModel, OtpModel, type OtpPurpose } from "../models/Otp";
import { HttpError } from "../utils/HttpError";

const OTP_TTL_MS = 10 * 60 * 1000;
export const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;
// Wrong codes allowed per email and purpose over a rolling day, across every code issued in it.
export const MAX_DAILY_FAILURES = 20;
const FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;

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
  const now = new Date();
  // Past the daily cap, every code is wrong without being compared. A burst of guesses can pass the cap by
  // at most one code's attempts, since those are counted atomically below.
  const failures = await OtpFailureModel.countDocuments({ email, purpose, expiresAt: { $gt: now } });
  if (failures >= MAX_DAILY_FAILURES) return false;

  // The attempt is counted before comparing, in one conditional update, so parallel guesses each use one up.
  const otp = await OtpModel.findOneAndUpdate(
    { email, purpose, attempts: { $lt: MAX_ATTEMPTS }, expiresAt: { $gt: now } },
    { $inc: { attempts: 1 } },
    { returnDocument: "after" },
  );
  if (!otp) return false;

  const matches = timingSafeEqual(Buffer.from(hash(code)), Buffer.from(otp.codeHash));
  if (!matches) {
    await OtpFailureModel.create({ email, purpose, expiresAt: new Date(now.getTime() + FAILURE_WINDOW_MS) });
    return false;
  }

  // Only the request that deletes the code signs in, so the same code can't be used twice at once.
  const { deletedCount } = await OtpModel.deleteOne({ _id: otp._id });
  return deletedCount === 1;
}
