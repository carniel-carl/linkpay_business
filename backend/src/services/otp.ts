import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { ipKeyGenerator } from "express-rate-limit";
import { OtpFailureModel, OtpModel, type OtpPurpose } from "../models/Otp";
import { HttpError } from "../utils/HttpError";

const OTP_TTL_MS = 10 * 60 * 1000;
export const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;
// Wrong codes allowed per email and purpose over a rolling day, across every code issued in it. Counted per client
// address, so a stranger who knows the email uses up only their own address's tries and the owner's still work;
// and across all addresses, a higher cap that bounds guessing from many addresses at once.
export const MAX_DAILY_FAILURES = 10;
export const MAX_DAILY_FAILURES_ALL_CLIENTS = 50;
const FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;
// Stands for "no address given" (scripts, and callers behind a session, where only its holder can guess).
const NO_CLIENT = "-";

const hash = (code: string) => createHash("sha256").update(code).digest("hex");

/** The client a wrong code is counted against: its address as the rate limits group it, hashed. */
const clientOf = (ip?: string) => (ip ? createHash("sha256").update(ipKeyGenerator(ip)).digest("base64url") : NO_CLIENT);

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

/**
 * Returns true and consumes the code if it matches; counts failed attempts otherwise. `ip` is the client address
 * (req.ip): wrong codes from it count against it, and against the email across all addresses.
 */
export async function verifyOtp(email: string, purpose: OtpPurpose, code: string, { ip }: { ip?: string } = {}): Promise<boolean> {
  const now = new Date();
  const client = clientOf(ip);
  // Past either daily cap, every code is wrong without being compared. A burst of guesses can pass a cap by at
  // most one code's attempts, since those are counted atomically below; so in a day at most
  // MAX_DAILY_FAILURES_ALL_CLIENTS + 5 wrong codes are ever compared for one email and purpose.
  const live = { email, purpose, expiresAt: { $gt: now } };
  const [fromClient, fromAll] = await Promise.all([
    OtpFailureModel.countDocuments({ ...live, client }),
    OtpFailureModel.countDocuments(live),
  ]);
  if (fromClient >= MAX_DAILY_FAILURES || fromAll >= MAX_DAILY_FAILURES_ALL_CLIENTS) return false;

  // The attempt is counted before comparing, in one conditional update, so parallel guesses each use one up.
  const otp = await OtpModel.findOneAndUpdate(
    { email, purpose, attempts: { $lt: MAX_ATTEMPTS }, expiresAt: { $gt: now } },
    { $inc: { attempts: 1 } },
    { returnDocument: "after" },
  );
  if (!otp) return false;

  const matches = timingSafeEqual(Buffer.from(hash(code)), Buffer.from(otp.codeHash));
  if (!matches) {
    await OtpFailureModel.create({ email, purpose, client, expiresAt: new Date(now.getTime() + FAILURE_WINDOW_MS) });
    return false;
  }

  // Only the request that deletes the code signs in, so the same code can't be used twice at once.
  const { deletedCount } = await OtpModel.deleteOne({ _id: otp._id });
  return deletedCount === 1;
}
