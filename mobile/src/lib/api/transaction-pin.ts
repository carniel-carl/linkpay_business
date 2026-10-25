import { queryOptions, useQuery } from "@tanstack/react-query";
import { formatDateTime, formatTime, lagosDate } from "@/lib/format";
import { api } from "./client";
import { ApiError } from "./errors";
import type { TransactionPinStatus } from "./types";

// /api/transaction-pin (docs/briefs/transaction-pin.md). One PIN per user, for every business they're in, so
// nothing here is business-scoped. A PIN only ever travels as the X-Transaction-Pin header of the one covered
// request it confirms, or in the body of the PIN requests below. It's never stored, cached or put in a route.

export const PIN_LENGTH = 4;

/** The header a covered request carries the PIN in. Pass it to that one request only. */
export const pinHeader = (pin: string) => ({ "X-Transaction-Pin": pin });

export const pinStatusQuery = queryOptions({
  queryKey: ["transaction-pin"],
  queryFn: () => api<TransactionPinStatus>("/api/transaction-pin"),
});

export const useTransactionPinStatus = () => useQuery(pinStatusQuery);

/**
 * Locked right now. A lock whose time has passed has ended, even before the status is read again; one until a reset
 * (`resetRequired`, too many wrong tries in a day) has no end time.
 */
export const isPinLocked = (s: Pick<TransactionPinStatus, "locked" | "lockedUntil" | "resetRequired">) =>
  !!s.resetRequired || (s.locked && (!s.lockedUntil || Date.parse(s.lockedUntil) > Date.now()));

/** The first PIN. Needs the account password. */
export const setTransactionPin = (pin: string, password: string) =>
  api<TransactionPinStatus>("/api/transaction-pin", { method: "POST", json: { pin, password } });

/** A new PIN, with the current PIN (a wrong one counts toward the lock) or the password. */
export const changeTransactionPin = (newPin: string, proof: { currentPin: string } | { password: string }) =>
  api<TransactionPinStatus>("/api/transaction-pin/change", { method: "POST", json: { newPin, ...proof } });

/** Emails a 6-digit code (10 minutes) for a forgotten or locked PIN. One a minute (OTP_COOLDOWN). */
export const requestTransactionPinReset = () =>
  api<{ message: string; sentTo: string }>("/api/transaction-pin/reset/request", { method: "POST" });

/** A forgotten or locked PIN: the password and the emailed code. Also ends a lock. */
export const resetTransactionPin = (body: { password: string; code: string; newPin: string }) =>
  api<TransactionPinStatus>("/api/transaction-pin/reset", { method: "POST", json: body });

// ---- Rules and copy shared by the confirmation sheet and More, Transaction PIN ----

/**
 * The most common PINs the rules in isWeakPin don't already catch: pairs and mirrors (1212, 1122, 1221), keypad
 * shapes (2580, 1379, 7890) and PINs with a meaning (1004, 6969, 5683). The same list as COMMON_PINS in
 * backend/src/services/transactionPin.ts and web/src/lib/transaction-pin.ts: change all three together.
 */
const COMMON_PINS: ReadonlySet<string> = new Set([
  "0101", "1010", "1212", "1313", "1414", "1515", "2121", "2323", "2525", "4545", "6969",
  "0011", "1100", "1122", "2211",
  "0110", "1001", "1221", "2112",
  "0741", "0852", "0963", "1470", "2580", "3690", "1379", "1397", "7913", "9731", "1590", "3570", "2468", "7890", "0987",
  "0007", "1004", "5683",
]);

/**
 * The server's rule (WEAK_TRANSACTION_PIN), checked before anything is sent: four of one digit, straight runs up or
 * down (1234, 9876), years from 1950 to 2030, and COMMON_PINS.
 */
export function isWeakPin(pin: string) {
  const digits = [...pin].map(Number);
  const steps = new Set(digits.slice(1).map((d, i) => d - digits[i]));
  if (steps.size === 1 && [0, 1, -1].includes([...steps][0])) return true;
  const asYear = Number(pin);
  return (asYear >= 1950 && asYear <= 2030) || COMMON_PINS.has(pin);
}

export const WEAK_PIN = "That PIN is too easy to guess. Avoid repeated digits, runs like 1234, years and other common PINs.";

export const isApiCode = (err: unknown, ...codes: string[]): err is ApiError =>
  err instanceof ApiError && !!err.code && codes.includes(err.code);

/** "Wrong PIN. 3 tries left.", from TRANSACTION_PIN_INVALID's `details.attemptsLeft` (1 to 4). */
export function wrongPinMessage(err: ApiError) {
  const left = (err.details as { attemptsLeft?: number } | undefined)?.attemptsLeft;
  if (typeof left !== "number") return "Wrong PIN. Try again.";
  return left === 1 ? "Wrong PIN. 1 try left before it locks." : `Wrong PIN. ${left} tries left.`;
}

/** When a locked PIN works again, from TRANSACTION_PIN_LOCKED's `details.lockedUntil`; null when only a reset ends it. */
export const lockedUntilOf = (err: ApiError) => (err.details as { lockedUntil?: string | null } | undefined)?.lockedUntil ?? null;

/** TRANSACTION_PIN_LOCKED after too many wrong tries in a day (`details.resetRequired`): locked until it's reset. */
export const resetRequiredOf = (err: ApiError) => (err.details as { resetRequired?: boolean } | undefined)?.resetRequired === true;

/** "3:45 pm", or with the date when that isn't today. Lagos time, like every time in the app. */
export const formatUnlock = (iso: string) => (lagosDate(iso) === lagosDate() ? formatTime(iso) : formatDateTime(iso));

/** One line for a locked PIN: for a while, or (`resetRequired`) until it's reset. */
export const lockedMessage = (until: string | null, resetRequired = false) =>
  resetRequired
    ? "Too many wrong tries today, so your PIN is locked until you reset it. Reset your PIN with your password and a code we email you."
    : until
      ? `Too many wrong tries, so your PIN is locked until ${formatUnlock(until)}. Reset it now with your password and a code we email you.`
      : "Too many wrong tries, so your PIN is locked for 30 minutes. Reset it now with your password and a code we email you.";
