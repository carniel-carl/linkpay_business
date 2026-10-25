import { Types } from "mongoose";
import { z } from "zod";
import { env } from "../config/env";
import { TransactionPinModel } from "../models/TransactionPin";
import { UserModel } from "../models/User";
import { HttpError } from "../utils/HttpError";
import { sendEmail, sendTransactionPinResetCodeEmail, sendTransactionPinSecurityEmail, type TransactionPinEvent } from "./email";
import { createOtp, verifyOtp } from "./otp";

// The transaction PIN: 4 digits each business user sets, separate from their password and from the mobile
// app's passcode. The server checks it before money is sent or approved, taken out of savings or locked away,
// and before the business's security settings change (middleware/transactionPin.ts; the routes files say
// where). So a stolen bearer token alone can't do any of those.

export const MAX_PIN_ATTEMPTS = 5;
export const PIN_LOCK_MS = 30 * 60 * 1000;
// Wrong PINs allowed over any 24 hours, however many 30-minute locks they're spread across. Without it each lock
// would start the count again: 240 guesses a day, every day. Past it the PIN is locked until it's reset.
export const MAX_DAILY_PIN_FAILURES = 15;
export const PIN_FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;

const PIN_FORMAT = /^\d{4}$/;
export const pinSchema = z.string().regex(PIN_FORMAT, "The transaction PIN must be 4 digits");

/**
 * The most common 4-digit PINs the rules in isWeakPin don't already catch, from published PIN-frequency studies
 * (the DataGenetics analysis of 3.4 million PINs, iPhone passcode counts, Bonneau et al.'s banking-PIN study): pairs
 * and mirrors (1212, 1122, 1221), keypad shapes (2580 down the middle, 1379 the corners, 7890 the keyboard's top
 * row), and PINs with a meaning (1004, 6969, 5683 spells LOVE). Mirrored in web/src/lib/transaction-pin.ts and the
 * mobile app's lib/api/transaction-pin.ts: change all three together.
 */
export const COMMON_PINS: ReadonlySet<string> = new Set([
  "0101", "1010", "1212", "1313", "1414", "1515", "2121", "2323", "2525", "4545", "6969",
  "0011", "1100", "1122", "2211",
  "0110", "1001", "1221", "2112",
  "0741", "0852", "0963", "1470", "2580", "3690", "1379", "1397", "7913", "9731", "1590", "3570", "2468", "7890", "0987",
  "0007", "1004", "5683",
]);

/**
 * The first PINs anyone would try: four of one digit (0000), straight runs up or down (1234, 9876), years from
 * 1950 to 2030 (birth years, 2000), and COMMON_PINS.
 */
export function isWeakPin(pin: string) {
  const digits = [...pin].map(Number);
  const steps = new Set(digits.slice(1).map((d, i) => d - digits[i]!));
  if (steps.size === 1 && [0, 1, -1].includes([...steps][0]!)) return true;
  const asYear = Number(pin);
  return (asYear >= 1950 && asYear <= 2030) || COMMON_PINS.has(pin);
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
    { lockedUntil: lockedUntil.toISOString(), retryAt: lockedUntil.toISOString(), attemptsLeft: 0, resetRequired: false },
  );
/**
 * Too many wrong PINs in a day: locked until it's reset. The same code as a timed lock, so clients that only know
 * that one still show it as locked and offer the reset; `resetRequired` (with no unlock time) says waiting won't help.
 */
const pinResetRequired = () =>
  new HttpError(
    429,
    "Your transaction PIN is locked after too many wrong tries today. Reset it with your password and a code we email you.",
    "TRANSACTION_PIN_LOCKED",
    { lockedUntil: null, retryAt: null, attemptsLeft: 0, resetRequired: true },
  );
const alreadySet = () =>
  new HttpError(409, "You already have a transaction PIN. Change it instead.", "TRANSACTION_PIN_ALREADY_SET");

function assertStrong(pin: string) {
  if (isWeakPin(pin)) {
    throw new HttpError(
      400,
      "That PIN is too easy to guess. Avoid repeated digits, runs like 1234, years and other common PINs.",
      "WEAK_TRANSACTION_PIN",
    );
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

type PinEmail = TransactionPinEvent | "locked_until_reset";

/** The daily cap's lock. email.ts's "locked" email names the time it ends, and this one has none. */
const sendLockedUntilResetEmail = (to: string) =>
  sendEmail({
    to,
    subject: `Your ${env.appName} transaction PIN is locked`,
    text:
      `Your transaction PIN was entered wrongly too many times today, so it's locked until you reset it with your ` +
      `password and a code we email you. You can't send money or approve transfers until then.\n\n` +
      `If this wasn't you, sign out your other devices and contact support straight away.`,
  });

/** Security emails go out after the change is saved, so a failed send mustn't turn it into an error. */
async function tellUser(email: string, event: PinEmail, opts?: { lockedUntil?: Date }) {
  try {
    if (event === "locked_until_reset") await sendLockedUntilResetEmail(email);
    else await sendTransactionPinSecurityEmail(email, event, opts);
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

/** The record's wrong PINs still inside the rolling day, as an expression for conditional updates. */
const failuresSince = (since: Date) => ({
  $filter: { input: { $ifNull: ["$recentFailures", []] }, cond: { $gt: ["$$this.at", since] } },
});
const dayAgo = (now = Date.now()) => new Date(now - PIN_FAILURE_WINDOW_MS);

/** The same count, on a record already loaded. */
const failuresToday = (record: { recentFailures?: { at: Date }[] }) => {
  const since = dayAgo().getTime();
  return (record.recentFailures ?? []).filter((f) => f.at.getTime() > since).length;
};

/** Why the PIN can't be used right now (none set, locked until a reset, locked for a while), or null if it can. */
async function refusal(userId: string) {
  const record = await TransactionPinModel.findOne({ user: userId });
  if (!record) return pinRequired();
  if (record.resetRequiredAt) return pinResetRequired();
  if (record.lockedUntil) return pinLocked(record.lockedUntil);
  return null;
}

// ---- Status ----

export async function pinStatus(userId: string) {
  const record = await TransactionPinModel.findOne({ user: userId });
  if (!record) return { isSet: false, locked: false, lockedUntil: null, attemptsLeft: null, changedAt: null, resetRequired: false };
  if (record.resetRequiredAt) {
    return { isSet: true, locked: true, lockedUntil: null, attemptsLeft: 0, changedAt: record.changedAt, resetRequired: true };
  }
  const now = Date.now();
  const lockedUntil = record.lockedUntil && record.lockedUntil.getTime() > now ? record.lockedUntil : null;
  const lockEnded = !!record.lockedUntil && !lockedUntil;
  const inARow = lockedUntil ? 0 : lockEnded ? MAX_PIN_ATTEMPTS : MAX_PIN_ATTEMPTS - record.failedAttempts;
  return {
    isSet: true,
    locked: !!lockedUntil,
    lockedUntil,
    // Whichever lock is nearer: the one after 5 in a row, or the one after the day's cap.
    attemptsLeft: Math.max(0, Math.min(inARow, MAX_DAILY_PIN_FAILURES - failuresToday(record))),
    changedAt: record.changedAt,
    resetRequired: false,
  };
}

// ---- Checking the PIN on a covered request ----

/**
 * Why a try wasn't let in. Normally the request that used the last try has set the lock by now; if it never got
 * that far, the lock is set here instead: until a reset when the day's cap was reached, otherwise for PIN_LOCK_MS
 * from the time of that try. Both updates are conditional, so a PIN reset in the meantime stays unlocked.
 */
async function lockedOut(userId: string) {
  const existing = await TransactionPinModel.findOne({ user: userId });
  if (!existing) return pinRequired();
  if (existing.resetRequiredAt) return pinResetRequired();
  if (failuresToday(existing) >= MAX_DAILY_PIN_FAILURES) {
    await TransactionPinModel.updateOne(
      {
        _id: existing._id,
        resetRequiredAt: null,
        $expr: { $gte: [{ $size: failuresSince(dayAgo()) }, MAX_DAILY_PIN_FAILURES] },
      },
      { $set: { resetRequiredAt: new Date() } },
    );
    return pinResetRequired();
  }
  let lockedUntil = existing.lockedUntil;
  if (!lockedUntil) {
    lockedUntil = new Date(existing.get("updatedAt").getTime() + PIN_LOCK_MS);
    await TransactionPinModel.updateOne(
      { _id: existing._id, lockedUntil: null, failedAttempts: { $gte: MAX_PIN_ATTEMPTS } },
      { $set: { lockedUntil } },
    );
  }
  return pinLocked(lockedUntil);
}

/**
 * Throws unless `pin` is the user's transaction PIN. Each try is counted before comparing, in one conditional
 * update, twice: towards 5 in a row, and as a dated entry towards MAX_DAILY_PIN_FAILURES over the last 24 hours.
 * So a burst of parallel guesses each uses up an attempt of both. The fifth wrong one in a row locks the PIN for
 * PIN_LOCK_MS; the day's last one locks it until it's reset with the password and an emailed code (resetRequired).
 * Either emails the user. A right PIN resets the count in a row, even if the action is then refused for another
 * reason (say, not enough money), and takes its own try back off the day's; earlier wrong ones stay counted for a
 * day. argon2's verify takes the same time for any wrong PIN.
 */
export async function verifyTransactionPin(userId: string, pin: string | undefined) {
  await endExpiredLock(userId);

  if (!pin || !PIN_FORMAT.test(pin)) {
    // Not a guess, so not counted. Clients still learn whether to ask for the PIN, to set one up, or to reset it.
    throw (await refusal(userId)) ?? pinMissing();
  }

  const now = new Date();
  const today = failuresSince(dayAgo(now.getTime()));
  // Its own id, so a try that turns out right can take itself back out without touching anyone else's.
  const attempt = new Types.ObjectId();
  const record = await TransactionPinModel.findOneAndUpdate(
    {
      user: userId,
      failedAttempts: { $lt: MAX_PIN_ATTEMPTS },
      lockedUntil: null,
      resetRequiredAt: null,
      $expr: { $lt: [{ $size: today }, MAX_DAILY_PIN_FAILURES] },
    },
    [
      {
        $set: {
          failedAttempts: { $add: ["$failedAttempts", 1] },
          // Entries older than a day drop out here, so the list only ever holds the last day's.
          recentFailures: { $concatArrays: [today, [{ $literal: { _id: attempt, at: now } }]] },
        },
      },
    ],
    { returnDocument: "after", updatePipeline: true },
  ).select("+pinHash");

  if (!record) throw await lockedOut(userId);

  if (await Bun.password.verify(pin, record.pinHash)) {
    await TransactionPinModel.updateOne(
      { _id: record._id },
      { $set: { failedAttempts: 0, lastUsedAt: new Date() }, $pull: { recentFailures: { _id: attempt } } },
    );
    return;
  }

  // This guess used the day's last try. Only one request can see the list reach the cap, so only one locks and
  // emails. The filter skips a PIN that was changed or reset in the meantime (that empties the list).
  const usedToday = record.recentFailures.length;
  if (usedToday >= MAX_DAILY_PIN_FAILURES) {
    const locked = await TransactionPinModel.updateOne(
      { _id: record._id, "recentFailures._id": attempt },
      { $set: { resetRequiredAt: new Date() } },
    );
    if (!locked.matchedCount) throw pinInvalid(MAX_PIN_ATTEMPTS);
    await tellUser((await findUser(userId, "email")).email, "locked_until_reset");
    throw pinResetRequired();
  }

  const leftInARow = MAX_PIN_ATTEMPTS - record.failedAttempts;
  if (leftInARow > 0) throw pinInvalid(Math.min(leftInARow, MAX_DAILY_PIN_FAILURES - usedToday));

  // This guess used the last attempt in a row. Only one request can see the count reach the limit, so only one
  // locks and emails. The filter skips a PIN that was changed or reset in the meantime.
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

/** A new PIN starts with no wrong tries and no lock of either kind. */
async function replacePin(userId: string, pin: string) {
  const updated = await TransactionPinModel.updateOne(
    { user: userId },
    {
      $set: { pinHash: await hashPin(pin), changedAt: new Date(), failedAttempts: 0, recentFailures: [] },
      $unset: { lockedUntil: 1, resetRequiredAt: 1 },
    },
  );
  if (!updated.matchedCount) throw pinRequired();
}

/**
 * Changes the PIN with the current PIN (checked and counted like any other use) or the account password.
 * While the PIN is locked only a reset can replace it: someone may be guessing with this session, so ending
 * the lock early takes the password and a code sent to the account's email.
 *
 * The password route takes no emailed code. It's for someone who knows their password but not their PIN, and it
 * stays one step: the password checks behind a session share one tight limit (middleware/rateLimits.ts), so a
 * stolen session can't find the password here, and the user is emailed about every change. Someone holding both a
 * session and the password can already change the password and turn off two-step verification.
 */
export async function changePin(userId: string, proof: { currentPin: string } | { password: string }, newPin: string) {
  assertStrong(newPin);
  if ("currentPin" in proof) {
    await verifyTransactionPin(userId, proof.currentPin);
  } else {
    await endExpiredLock(userId);
    const refused = await refusal(userId);
    if (refused) throw refused;
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

/** A forgotten PIN: the account password plus the emailed code. Also ends a lock, either kind. */
export async function resetPin(userId: string, password: string, code: string, newPin: string, { ip }: { ip?: string } = {}) {
  assertStrong(newPin);
  if (!(await TransactionPinModel.exists({ user: userId }))) throw pinRequired();
  const user = await checkPassword(userId, password);
  // Codes are counted per code, and per day for each address and in all (services/otp.ts).
  if (!(await verifyOtp(user.email, "transaction_pin_reset", code, { ip }))) {
    throw new HttpError(400, "Invalid or expired code", "INVALID_CODE");
  }
  await replacePin(userId, newPin);
  await tellUser(user.email, "reset");
}
