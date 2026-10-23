import { pbkdf2Async } from "@noble/hashes/pbkdf2.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import * as Crypto from "expo-crypto";
import { KEYS, secureDelete, secureGet, secureSet } from "@/lib/auth/secure-storage";

export const PASSCODE_LENGTH = 4;
/** Wrong entries allowed before the app signs out and wipes this device's session. */
export const MAX_ATTEMPTS = 5;
// Hashing runs in JavaScript on Hermes (no JIT), where 60k rounds took seconds per unlock. A 4-digit code
// has only 10,000 values, so no round count stops an offline guesser; the device-only keychain item and
// the 5-try sign-out are what protect it. The hash just keeps the code itself out of storage.
const ITERATIONS = 1_000;

// v2 is the 4-digit format. A v1 record holds a 6-digit code that can't be typed any more.
type Stored = { v: 2; salt: string; hash: string };

async function derive(passcode: string, salt: Uint8Array) {
  return bytesToHex(await pbkdf2Async(sha256, passcode, salt, { c: ITERATIONS, dkLen: 32 }));
}

function equal(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Repeated digits, straight runs and the like are the first codes anyone tries. */
export function isTooSimple(passcode: string) {
  if (/^(\d)\1+$/.test(passcode)) return true;
  const digits = [...passcode].map(Number);
  const steps = digits.slice(1).map((d, i) => d - digits[i]);
  if (steps.every((s) => s === 1) || steps.every((s) => s === -1)) return true;
  return ["1212", "1122", "6969", "1010", "2580", "0852", "2000", "1004"].includes(passcode);
}

export async function setPasscode(passcode: string) {
  const salt = Crypto.getRandomBytes(16);
  const stored: Stored = { v: 2, salt: bytesToHex(salt), hash: await derive(passcode, salt) };
  await secureSet(KEYS.passcode, JSON.stringify(stored));
  await secureDelete(KEYS.attempts);
}

/** False when none is set, or when an older 6-digit one is dropped so the phone asks for a new code. */
export async function hasPasscode() {
  const raw = await secureGet(KEYS.passcode);
  if (!raw) return false;
  if ((JSON.parse(raw) as { v?: number }).v === 2) return true;
  await Promise.all([secureDelete(KEYS.passcode), secureDelete(KEYS.attempts)]);
  return false;
}

export async function failedAttempts() {
  return Number((await secureGet(KEYS.attempts)) ?? 0);
}

export type VerifyResult = { ok: true } | { ok: false; attemptsLeft: number };

/** Out of tries (attemptsLeft 0) means the caller signs out; the code isn't even checked then. */
export async function verifyPasscode(passcode: string): Promise<VerifyResult> {
  const raw = await secureGet(KEYS.passcode);
  if (!raw) return { ok: false, attemptsLeft: 0 };
  const failed = await failedAttempts();
  if (failed >= MAX_ATTEMPTS) return { ok: false, attemptsLeft: 0 };
  // Counted before the check, so closing the app mid-check can't make a guess free.
  const attempts = failed + 1;
  await secureSet(KEYS.attempts, String(attempts));
  const stored = JSON.parse(raw) as Stored;
  if (equal(await derive(passcode, hexToBytes(stored.salt)), stored.hash)) {
    await secureDelete(KEYS.attempts);
    return { ok: true };
  }
  return { ok: false, attemptsLeft: Math.max(0, MAX_ATTEMPTS - attempts) };
}

/** A successful biometric unlock also clears the wrong-passcode count. */
export const resetAttempts = () => secureDelete(KEYS.attempts);
