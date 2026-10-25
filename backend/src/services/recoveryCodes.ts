import { createHmac, hkdfSync, randomInt } from "node:crypto";
import { env } from "../config/env";
import { StaffModel } from "../models/Staff";
import { UserModel } from "../models/User";
import { accountKind, countChallengeAttempt, type TotpAccount } from "./totp";

// Recovery codes: one-time codes that stand in for the authenticator app at sign-in, for someone who has lost
// their phone. Business users and staff both get them while their method is "totp". Ten at a time, shown once.
//
// Only a keyed hash of each is stored (HMAC-SHA256 with a key derived from ENCRYPTION_KEY, over the account and the
// code), so the database alone isn't enough to test guesses offline, and a hash copied onto another account
// doesn't match there. A code is used up by removing its hash in one conditional update, so two sign-ins with the
// same code at once can't both succeed.

export const RECOVERY_CODE_COUNT = 10;
// No 0 or o, and no 1, l or i: nothing that reads as something else.
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const LENGTH = 10;
const SHAPE = new RegExp(`^[${ALPHABET}]{${LENGTH}}$`);

const key = Buffer.from(hkdfSync("sha256", Buffer.from(env.encryptionKey, "hex"), "", "linkpay recovery codes", 32));

/** How a typed code is compared: trimmed, lowercase, spaces and dashes dropped. */
export const normalizeRecoveryCode = (code: string) => code.trim().toLowerCase().replace(/[\s-]+/g, "");

const hashOf = (account: TotpAccount, normalized: string) =>
  createHmac("sha256", key).update(`${accountKind(account)}:${account._id}:${normalized}`).digest("base64url");

/** A fresh set for the account: the codes to show (`xxxxx-xxxxx`), and the hashes to store. */
export function newRecoveryCodes(account: TotpAccount) {
  const raw = new Set<string>();
  while (raw.size < RECOVERY_CODE_COUNT) {
    raw.add(Array.from({ length: LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join(""));
  }
  const codes = [...raw];
  return {
    codes: codes.map((c) => `${c.slice(0, 5)}-${c.slice(5)}`),
    hashes: codes.map((c) => hashOf(account, c)),
  };
}

/** The fields that store a fresh set (enabling the authenticator, or making new codes). */
export const recoveryCodeFields = (hashes: string[]) => ({
  "twoFactor.recoveryCodes": hashes,
  "twoFactor.recoveryCodesLeft": hashes.length,
});

/** The fields that remove them (switching to email codes, or turning two-step off). */
export const NO_RECOVERY_CODES = { "twoFactor.recoveryCodes": undefined, "twoFactor.recoveryCodesLeft": 0 };

/** Only while the authenticator is the method: recovery codes stand in for nothing else. */
const totpFilter = (account: TotpAccount): Record<string, unknown> =>
  accountKind(account) === "staff" ? { "twoFactor.method": "totp" } : { "twoFactor.enabled": true, "twoFactor.method": "totp" };

/**
 * Stores a fresh set in place of any earlier one, if the account's method is still "totp" (checked in the same
 * update). Returns the codes to show, or null if it isn't.
 */
export async function replaceRecoveryCodes(account: TotpAccount): Promise<string[] | null> {
  const { codes, hashes } = newRecoveryCodes(account);
  const filter = { _id: account._id, ...totpFilter(account) };
  const update = { $set: recoveryCodeFields(hashes) };
  const result =
    accountKind(account) === "staff" ? await StaffModel.updateOne(filter, update) : await UserModel.updateOne(filter, update);
  return result.matchedCount === 1 ? codes : null;
}

/**
 * Uses one of the account's recovery codes at sign-in. The attempt counts against the challenge first, like an
 * authenticator code (TOO_MANY_ATTEMPTS once it has had its tries). Returns how many codes are left, or null if
 * this isn't one of the account's unused codes.
 */
export async function useRecoveryCode(account: TotpAccount, code: string, { challengeId }: { challengeId: string }): Promise<number | null> {
  await countChallengeAttempt(challengeId);
  const normalized = normalizeRecoveryCode(code);
  if (!SHAPE.test(normalized)) return null;

  const hash = hashOf(account, normalized);
  const filter = { _id: account._id, ...totpFilter(account), "twoFactor.recoveryCodes": hash };
  const update = { $pull: { "twoFactor.recoveryCodes": hash }, $inc: { "twoFactor.recoveryCodesLeft": -1 } };
  const options = { returnDocument: "after" as const };
  const used =
    accountKind(account) === "staff"
      ? await StaffModel.findOneAndUpdate(filter, update, options)
      : await UserModel.findOneAndUpdate(filter, update, options);
  return used ? Math.max(0, used.twoFactor?.recoveryCodesLeft ?? 0) : null;
}
