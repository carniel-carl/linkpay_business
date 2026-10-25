import type { Types } from "mongoose";
import { Secret, TOTP } from "otpauth";
import { env } from "../config/env";
import { StaffModel, type StaffDocument } from "../models/Staff";
import { TotpChallengeModel, TotpFailureModel } from "../models/TotpAttempt";
import { UserModel, type UserDocument } from "../models/User";
import { decrypt, encrypt } from "../utils/crypto";
import { HttpError } from "../utils/HttpError";

// Codes allowed per sign-in challenge, and wrong codes per account over a rolling day (across challenges and
// step-ups), like emailed codes. Past either, codes aren't compared at all.
const MAX_CHALLENGE_ATTEMPTS = 5;
export const MAX_DAILY_TOTP_FAILURES = 20;
const FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;
// Longer than a challenge token lives (10 minutes).
const CHALLENGE_KEPT_MS = 15 * 60 * 1000;

/** A business user or staff member, with an authenticator secret. */
export type TotpAccount = UserDocument | StaffDocument;
export type TotpAccountKind = "user" | "staff";
export const accountKind = (account: TotpAccount): TotpAccountKind => (account instanceof StaffModel ? "staff" : "user");

// ---- Secrets at rest ----

export const TOTP_SECRET_FIELDS = ["totpSecret", "pendingTotpSecret"] as const;
export type TotpSecretField = (typeof TOTP_SECRET_FIELDS)[number];

/**
 * What a stored secret is bound to (utils/crypto.ts, v2): this account and this field, as BVNs are bound to their
 * person. A secret copied onto another account, or from the pending field to the active one, doesn't decrypt.
 */
export const totpSecretContext = (kind: TotpAccountKind, id: Types.ObjectId | string, field: TotpSecretField) =>
  `${kind}:${id}:twoFactor.${field}`;

/** How otpauth writes a secret: base32, as every secret was stored before they were encrypted. */
export const isPlainTotpSecret = (stored: string) => /^[A-Z2-7]+=*$/.test(stored);

const plainRefused = () =>
  new Error(
    "Refusing an authenticator (TOTP) secret stored in plain text: ENCRYPTION_REQUIRE_V2=1 is set. " +
      "Run `bun run migrate:encryption --apply` to encrypt it, or unset ENCRYPTION_REQUIRE_V2.",
  );

/** The value to store in `field` for a base32 secret. */
export const sealTotpSecret = (account: TotpAccount, field: TotpSecretField, base32: string) =>
  encrypt(base32, totpSecretContext(accountKind(account), account._id, field));

/**
 * The base32 secret in `field` (which the query must have selected), or undefined if there's none. Reads the
 * encrypted form and, until the migration has run, plain base32; with ENCRYPTION_REQUIRE_V2=1 a plain one is
 * refused, as old-format values are.
 */
export function readTotpSecret(account: TotpAccount, field: TotpSecretField): string | undefined {
  const stored = account.twoFactor?.[field];
  if (!stored) return undefined;
  if (stored.startsWith("v2:")) return decrypt(stored, totpSecretContext(accountKind(account), account._id, field));
  if (!isPlainTotpSecret(stored)) throw new Error(`The stored authenticator secret (${field}) is neither encrypted nor base32`);
  if (env.encryptionRequireV2) throw plainRefused();
  return stored;
}

// ---- Codes ----

const build = (email: string, secret: Secret, issuer = env.appName) =>
  new TOTP({ issuer, label: email, algorithm: "SHA1", digits: 6, period: 30, secret });

export function generateTotpSecret(email: string, issuer?: string) {
  const secret = new Secret({ size: 20 });
  return { secret: secret.base32, otpauthUrl: build(email, secret, issuer).toString() };
}

/** The 30-second step a code belongs to, or null. window: 1 accepts the previous/next step to tolerate clock drift. */
function stepOf(email: string, base32Secret: string, code: string) {
  const totp = build(email, Secret.fromBase32(base32Secret));
  const timestamp = Date.now();
  const delta = totp.validate({ token: code, window: 1, timestamp });
  return delta === null ? null : totp.counter({ timestamp }) + delta;
}

const tooManyAttempts = (message: string) => new HttpError(429, message, "TOO_MANY_ATTEMPTS");

/**
 * Counts one attempt on a challenge, before the code is compared. Throws once the challenge has had its tries.
 * Authenticator codes and recovery codes (services/recoveryCodes.ts) share the count.
 */
export async function countChallengeAttempt(challengeId: string) {
  try {
    // Past the limit the filter misses, and the upsert then collides with the existing jti.
    await TotpChallengeModel.updateOne(
      { jti: challengeId, attempts: { $lt: MAX_CHALLENGE_ATTEMPTS } },
      { $inc: { attempts: 1 }, $setOnInsert: { expiresAt: new Date(Date.now() + CHALLENGE_KEPT_MS) } },
      { upsert: true },
    );
  } catch (err: any) {
    if (err?.code !== 11000) throw err;
    throw tooManyAttempts("Too many wrong codes. Start signing in again.");
  }
}

/**
 * Accepts `step` for the account only if it's later than the last accepted one, in one conditional update so
 * the same code sent twice at once is accepted once. `force` sets it regardless (a new secret's first code).
 */
async function claimStep(account: TotpAccount, step: number, force = false) {
  const filter = { _id: account._id, ...(!force && { "twoFactor.totpLastStep": { $not: { $gte: step } } }) };
  const update = { $set: { "twoFactor.totpLastStep": step } };
  const result =
    account instanceof StaffModel ? await StaffModel.updateOne(filter, update) : await UserModel.updateOne(filter, update);
  return result.matchedCount === 1;
}

/**
 * Checks a code from the account's authenticator app. Each code is accepted once: a code whose 30-second step
 * is no later than the last one accepted is refused, so a code seen over someone's shoulder can't be replayed.
 * Wrong codes are counted per account (and attempts per sign-in challenge, `challengeId`, the token's jti);
 * past the limit this throws TOO_MANY_ATTEMPTS without comparing.
 *
 * `enrolling` is for the first code of a secret being set up: it isn't counted as a failure when wrong (the
 * secret isn't in use yet) and starts the secret's replay check from its step.
 */
export async function verifyTotp(
  account: TotpAccount,
  base32Secret: string,
  code: string,
  { challengeId, enrolling = false }: { challengeId?: string; enrolling?: boolean } = {},
): Promise<boolean> {
  const kind = accountKind(account);
  if (!enrolling) {
    // A burst of parallel guesses can pass the cap by a few, since failures are recorded after comparing;
    // the per-challenge count and the sign-in rate limits bound that.
    const failures = await TotpFailureModel.countDocuments({ account: account._id, kind, expiresAt: { $gt: new Date() } });
    if (failures >= MAX_DAILY_TOTP_FAILURES) throw tooManyAttempts("Too many wrong codes. Try again later.");
  }
  if (challengeId) await countChallengeAttempt(challengeId);

  const step = stepOf(account.email, base32Secret, code);
  if (step !== null && (await claimStep(account, step, enrolling))) return true;

  if (!enrolling) {
    await TotpFailureModel.create({ account: account._id, kind, expiresAt: new Date(Date.now() + FAILURE_WINDOW_MS) });
  }
  return false;
}
