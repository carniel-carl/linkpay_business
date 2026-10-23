import { z } from "zod";
import { TransactionPinModel } from "../models/TransactionPin";
import { UserModel } from "../models/User";
import { HttpError } from "../utils/HttpError";
import { sendTransactionPinResetCodeEmail, sendTransactionPinSecurityEmail, type TransactionPinEvent } from "./email";
import { createOtp, verifyOtp } from "./otp";

// The transaction PIN: 4 digits each business user sets, separate from their password and from the mobile
// app's passcode. The server checks it before money is sent or approved, taken out of savings or locked away,
// and before the business's security settings change (middleware/transactionPin.ts; the routes files say
// where). So a stolen bearer token alone can't do any of those.

export const MAX_PIN_ATTEMPTS = 5;
export const PIN_LOCK_MS = 30 * 60 * 1000;

const PIN_FORMAT = /^\d{4}$/;
export const pinSchema = z.string().regex(PIN_FORMAT, "The transaction PIN must be 4 digits");

/** 0000, 1111, ... and straight runs up or down (1234, 9876): the first PINs anyone would try. */
export function isWeakPin(pin: string) {
  const digits = [...pin].map(Number);
  const steps = new Set(digits.slice(1).map((d, i) => d - digits[i]!));
  return steps.size === 1 && [0, 1, -1].includes([...steps][0]!);
}

// ---- Errors clients act on (see the codes in the API summary) ----

/** No PIN on this account yet: clients send people to set one. */
const pinRequired = () =>
  new HttpError(
    403,
    "Set a transaction PIN first. You'll need it to send money, approve transfers and change security settings.",
    "TRANSACTION_PIN_REQUIRED",
  );
/** The account has a PIN but the request didn't carry one (or not 4 digits): clients ask for it. Not counted. */
const pinMissing = () => new HttpError(403, "Enter your 4-digit transaction PIN.", "TRANSACTION_PIN_MISSING");
const pinInvalid = (attemptsLeft: number) =>
  new HttpError(
    403,
    `Wrong transaction PIN. ${attemptsLeft} ${attemptsLeft === 1 ? "try" : "tries"} left before it locks.`,
    "TRANSACTION_PIN_INVALID",
    { attemptsLeft },
  );
const pinLocked = (lockedUntil: Date) =>
  new HttpError(
    429,
    "Your transaction PIN is locked after too many wrong tries. Try again later, or reset it with your password and a code we email you.",
    "TRANSACTION_PIN_LOCKED",
    { lockedUntil: lockedUntil.toISOString(), retryAt: lockedUntil.toISOString(), attemptsLeft: 0 },
  );
const alreadySet = () =>
  new HttpError(409, "You already have a transaction PIN. Change it instead.", "TRANSACTION_PIN_ALREADY_SET");

function assertStrong(pin: string) {
  if (isWeakPin(pin)) {
    throw new HttpError(400, "That PIN is too easy to guess. Avoid repeated digits and runs like 1234.", "WEAK_TRANSACTION_PIN");
  }
}

const hashPin = (pin: string) => Bun.password.hash(pin, { algorithm: "argon2id" });

async function findUser(userId: string, select = "") {
  const user = await UserModel.findById(userId).select(select);
  if (!user) throw new HttpError(401, "This account no longer exists. Sign in again.", "UNAUTHENTICATED");
  return user;
}

/** 400, not 401: a wrong password here mustn't look to clients like the session ended. */
async function checkPassword(userId: string, password: string) {
  const user = await findUser(userId, "+password");
  // An account verified without its sign-up password has none until it's reset (services/passwords.ts).
  if (!user.password) {
    throw new HttpError(400, "This account has no password yet. Reset your password to choose one.", "PASSWORD_NOT_SET");
  }
  if (!(await Bun.password.verify(password, user.password).catch(() => false))) {
    throw new HttpError(400, "Incorrect password", "INCORRECT_PASSWORD");
  }
  return user;
}

/** Security emails go out after the change is saved, so a failed send mustn't turn it into an error. */
async function tellUser(email: string, event: TransactionPinEvent, opts?: { lockedUntil?: Date }) {
  try {
    await sendTransactionPinSecurityEmail(email, event, opts);
  } catch (err) {
    console.error(`Transaction PIN "${event}" email to ${email} failed:`, err);
  }
}

/** A lock whose time has passed starts the count again. Safe to run from any number of requests at once. */
const endExpiredLock = (userId: string) =>
  TransactionPinModel.updateOne(
    { user: userId, lockedUntil: { $lte: new Date() } },
    { $set: { failedAttempts: 0 }, $unset: { lockedUntil: 1 } },
  );

// ---- Status ----

export async function pinStatus(userId: string) {
  const record = await TransactionPinModel.findOne({ user: userId });
  if (!record) return { isSet: false, locked: false, lockedUntil: null, attemptsLeft: null, changedAt: null };
  const now = Date.now();
  const lockedUntil = record.lockedUntil && record.lockedUntil.getTime() > now ? record.lockedUntil : null;
  const lockEnded = !!record.lockedUntil && !lockedUntil;
  return {
    isSet: true,
    locked: !!lockedUntil,
    lockedUntil,
    attemptsLeft: lockedUntil ? 0 : lockEnded ? MAX_PIN_ATTEMPTS : Math.max(0, MAX_PIN_ATTEMPTS - record.failedAttempts),
    changedAt: record.changedAt,
  };
}

// ---- Checking the PIN on a covered request ----

/**
 * Throws unless `pin` is the user's transaction PIN. Each try is counted before comparing, in one conditional
 * update, so a burst of parallel guesses each uses up an attempt; the fifth wrong one locks the PIN for
 * PIN_LOCK_MS and emails the user. A right PIN resets the count, even if the action is then refused for
 * another reason (say, not enough money). argon2's verify takes the same time for any wrong PIN.
 */
export async function verifyTransactionPin(userId: string, pin: string | undefined) {
  await endExpiredLock(userId);

  if (!pin || !PIN_FORMAT.test(pin)) {
    // Not a guess, so not counted. Clients still learn whether to ask for the PIN or to set one up.
    const record = await TransactionPinModel.findOne({ user: userId });
    if (!record) throw pinRequired();
    if (record.lockedUntil) throw pinLocked(record.lockedUntil);
    throw pinMissing();
  }

  const record = await TransactionPinModel.findOneAndUpdate(
    { user: userId, failedAttempts: { $lt: MAX_PIN_ATTEMPTS }, lockedUntil: null },
    { $inc: { failedAttempts: 1 } },
    { returnDocument: "after" },
  ).select("+pinHash");

  if (!record) {
    const existing = await TransactionPinModel.findOne({ user: userId });
    if (!existing) throw pinRequired();
    // Normally the request that used the last attempt has set the lock by now. If it never got that far,
    // lock from the time of that attempt.
    let lockedUntil = existing.lockedUntil;
    if (!lockedUntil) {
      lockedUntil = new Date(existing.get("updatedAt").getTime() + PIN_LOCK_MS);
      await TransactionPinModel.updateOne(
        { _id: existing._id, lockedUntil: null, failedAttempts: { $gte: MAX_PIN_ATTEMPTS } },
        { $set: { lockedUntil } },
      );
    }
    throw pinLocked(lockedUntil);
  }

  if (await Bun.password.verify(pin, record.pinHash)) {
    await TransactionPinModel.updateOne({ _id: record._id }, { $set: { failedAttempts: 0, lastUsedAt: new Date() } });
    return;
  }

  const attemptsLeft = MAX_PIN_ATTEMPTS - record.failedAttempts;
  if (attemptsLeft > 0) throw pinInvalid(attemptsLeft);

  // This guess used the last attempt. Only one request can see the count reach the limit, so only one locks
  // and emails. The filter skips a PIN that was changed or reset in the meantime.
  const lockedUntil = new Date(Date.now() + PIN_LOCK_MS);
  const locked = await TransactionPinModel.updateOne(
    { _id: record._id, failedAttempts: { $gte: MAX_PIN_ATTEMPTS } },
    { $set: { lockedUntil } },
  );
  if (!locked.matchedCount) throw pinInvalid(MAX_PIN_ATTEMPTS);
  await tellUser((await findUser(userId, "email")).email, "locked", { lockedUntil });
  throw pinLocked(lockedUntil);
}

// ---- Setting, changing and resetting ----

/** The first PIN. Needs the account password, so a stolen session alone can't set one. */
export async function setFirstPin(userId: string, password: string, pin: string) {
  assertStrong(pin);
  if (await TransactionPinModel.exists({ user: userId })) throw alreadySet();
  const user = await checkPassword(userId, password);
  try {
    await TransactionPinModel.create({ user: user._id, pinHash: await hashPin(pin), changedAt: new Date() });
  } catch (err) {
    // Two first-time sets at once: the unique index lets one through.
    if ((err as { code?: number }).code === 11000) throw alreadySet();
    throw err;
  }
  await tellUser(user.email, "set");
}

async function replacePin(userId: string, pin: string) {
  const updated = await TransactionPinModel.updateOne(
    { user: userId },
    { $set: { pinHash: await hashPin(pin), changedAt: new Date(), failedAttempts: 0 }, $unset: { lockedUntil: 1 } },
  );
  if (!updated.matchedCount) throw pinRequired();
}

/**
 * Changes the PIN with the current PIN (checked and counted like any other use) or the account password.
 * While the PIN is locked only a reset can replace it: someone may be guessing with this session, so ending
 * the lock early takes the password and a code sent to the account's email.
 */
export async function changePin(userId: string, proof: { currentPin: string } | { password: string }, newPin: string) {
  assertStrong(newPin);
  if ("currentPin" in proof) {
    await verifyTransactionPin(userId, proof.currentPin);
  } else {
    await endExpiredLock(userId);
    const record = await TransactionPinModel.findOne({ user: userId });
    if (!record) throw pinRequired();
    if (record.lockedUntil) throw pinLocked(record.lockedUntil);
    await checkPassword(userId, proof.password);
  }
  await replacePin(userId, newPin);
  await tellUser((await findUser(userId, "email")).email, "changed");
}

/** Emails a 6-digit code for resetting a forgotten (or locked) PIN. One a minute (OTP_COOLDOWN). */
export async function requestPinReset(userId: string) {
  const user = await findUser(userId, "email");
  if (!(await TransactionPinModel.exists({ user: user._id }))) throw pinRequired();
  await sendTransactionPinResetCodeEmail(user.email, await createOtp(user.email, "transaction_pin_reset"));
  return user.email;
}

/** A forgotten PIN: the account password plus the emailed code. Also ends a lock. */
export async function resetPin(userId: string, password: string, code: string, newPin: string) {
  assertStrong(newPin);
  if (!(await TransactionPinModel.exists({ user: userId }))) throw pinRequired();
  const user = await checkPassword(userId, password);
  // Codes are counted per code and per day (services/otp.ts).
  if (!(await verifyOtp(user.email, "transaction_pin_reset", code))) {
    throw new HttpError(400, "Invalid or expired code", "INVALID_CODE");
  }
  await replacePin(userId, newPin);
  await tellUser(user.email, "reset");
}
