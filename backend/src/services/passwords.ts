import { z } from "zod";
import type { OtpPurpose } from "../models/Otp";
import { UserModel } from "../models/User";
import { HttpError } from "../utils/HttpError";
import { sendAccountExistsEmail, sendVerificationEmail } from "./email";
import { createOtp } from "./otp";

// Passwords chosen before the email is proven (audit H1). Anyone can sign up with any email, so until the
// owner proves the inbox with a code, the password on an account may be a stranger's. Verifying keeps it only
// when the code comes with the registration token that sign-up handed to its own client. Any other proof of
// the inbox (an emailed sign-in code, or verifying without the token) verifies the email and removes the
// password; the owner then sets their own with a password reset.

const REGISTRATION_TTL_MS = 24 * 60 * 60 * 1000;
const SIGN_UP_NOTICE_EVERY_MS = 60 * 60 * 1000;

/** The rules for every password a business user chooses: sign-up, invites, reset and change. */
export const passwordSchema = z.string().min(8, "Password must be at least 8 characters").max(128);

export const registrationTokenSchema = z.string().min(32).max(200);

const hash = (token: string) => new Bun.CryptoHasher("sha256").update(token).digest("hex");

const newRegistrationToken = () => `lprg_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`;

/**
 * Sends an email without waiting for it, for answers that must look the same whether or not an account exists:
 * a slow or failing email provider would otherwise show up, as a delay or a 500, only for real accounts. A failed
 * send is logged; whoever asked can ask again once the resend cooldown is over.
 */
export function sendInBackground(what: string, send: () => Promise<unknown>) {
  (async () => send())().catch((err) => console.error(`Couldn't send the ${what} email:`, err));
}

/**
 * Emails a fresh code, without waiting for the email (see sendInBackground). Within the resend cooldown the code
 * already sent is still valid, so nothing goes out and the caller can't tell, which keeps a cooldown from showing
 * that an account exists.
 */
export async function sendCodeIgnoringCooldown(email: string, purpose: OtpPurpose, send: (to: string, code: string) => Promise<unknown>) {
  let code: string;
  try {
    code = await createOtp(email, purpose);
  } catch (err) {
    if (err instanceof HttpError && err.code === "OTP_COOLDOWN") return;
    throw err;
  }
  sendInBackground(`${purpose.replaceAll("_", " ")} code`, () => send(email, code));
}

/**
 * Sign-up. A new email gets an unverified account. An email nobody has verified yet gets the new name and
 * password in place of the old ones, so whoever signed up first can't hold it, and only the latest token
 * counts. Both get a verification code. A verified account is left alone and its owner gets a note instead.
 * The token looks the same in every case, so the response never says whether the email was registered.
 */
export async function startRegistration(input: { name: string; email: string; password: string }) {
  const token = newRegistrationToken();
  const pending = {
    name: input.name,
    password: await Bun.password.hash(input.password),
    hasPassword: true,
    registration: { tokenHash: hash(token), expiresAt: new Date(Date.now() + REGISTRATION_TTL_MS) },
  };
  const replaced = await UserModel.updateOne({ email: input.email, emailVerified: false }, pending);
  if (!replaced.matchedCount) {
    const created = await UserModel.create({ email: input.email, ...pending }).catch((err) => {
      if (err?.code === 11000) return null;
      throw err;
    });
    if (!created) {
      await noteSignUpAttempt(input.email);
      // Stored nowhere, so it keeps no password.
      return token;
    }
  }
  await sendCodeIgnoringCooldown(input.email, "verify_email", sendVerificationEmail);
  return token;
}

/** At most one "you already have an account" email an hour per account, claimed in one update. */
async function noteSignUpAttempt(email: string) {
  const claimed = await UserModel.updateOne(
    {
      email,
      emailVerified: true,
      $or: [{ signUpNoticeAt: null }, { signUpNoticeAt: { $lt: new Date(Date.now() - SIGN_UP_NOTICE_EVERY_MS) } }],
    },
    { signUpNoticeAt: new Date() },
  );
  if (claimed.modifiedCount) sendInBackground("account exists", () => sendAccountExistsEmail(email));
}

/**
 * Call once a code has proved the inbox. Verifies the email; the sign-up's password survives only with that
 * sign-up's unexpired token, and is removed otherwise. Both updates are conditional, so a sign-up replacing
 * the password at the same moment can't slip its password through. Returns the account, or null if none.
 */
export async function confirmEmail(email: string, registrationToken?: string) {
  if (registrationToken) {
    const kept = await UserModel.findOneAndUpdate(
      { email, emailVerified: false, "registration.tokenHash": hash(registrationToken), "registration.expiresAt": { $gt: new Date() } },
      { emailVerified: true, $unset: { registration: 1 } },
      { returnDocument: "after" },
    );
    if (kept) return kept;
  }
  const cleared = await UserModel.findOneAndUpdate(
    { email, emailVerified: false },
    { emailVerified: true, hasPassword: false, $unset: { password: 1, registration: 1 } },
    { returnDocument: "after" },
  );
  return cleared ?? (await UserModel.findOne({ email }));
}

/** For actions that ask for the password again. An account without one is pointed at a reset. */
export async function assertPassword(userId: string | undefined, plain: string) {
  const user = await UserModel.findById(userId).select("+password");
  if (!user) throw new HttpError(401, "This account no longer exists. Sign in again.", "UNAUTHENTICATED");
  if (!user.password) {
    throw new HttpError(400, "This account has no password yet. Reset your password to choose one.", "PASSWORD_NOT_SET");
  }
  if (!(await Bun.password.verify(plain, user.password))) throw new HttpError(400, "Incorrect password", "INCORRECT_PASSWORD");
  return user;
}
