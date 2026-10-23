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

/** Locked right now. A lock whose time has passed has ended, even before the status is read again. */
export const isPinLocked = (s: Pick<TransactionPinStatus, "locked" | "lockedUntil">) =>
  s.locked && (!s.lockedUntil || Date.parse(s.lockedUntil) > Date.now());

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

/** The server's rule (WEAK_TRANSACTION_PIN), checked before anything is sent: four of one digit, or a straight run up or down. */
export function isWeakPin(pin: string) {
  const digits = [...pin].map(Number);
  const steps = new Set(digits.slice(1).map((d, i) => d - digits[i]));
  return steps.size === 1 && [0, 1, -1].includes([...steps][0]);
}

export const WEAK_PIN = "That PIN is easy to guess. Avoid repeated digits and runs like 1234.";

export const isApiCode = (err: unknown, ...codes: string[]): err is ApiError =>
  err instanceof ApiError && !!err.code && codes.includes(err.code);

/** "Wrong PIN. 3 tries left.", from TRANSACTION_PIN_INVALID's `details.attemptsLeft` (1 to 4). */
export function wrongPinMessage(err: ApiError) {
  const left = (err.details as { attemptsLeft?: number } | undefined)?.attemptsLeft;
  if (typeof left !== "number") return "Wrong PIN. Try again.";
  return left === 1 ? "Wrong PIN. 1 try left before it locks." : `Wrong PIN. ${left} tries left.`;
}

/** When a locked PIN works again, from TRANSACTION_PIN_LOCKED's `details.lockedUntil`. */
export const lockedUntilOf = (err: ApiError) => (err.details as { lockedUntil?: string } | undefined)?.lockedUntil ?? null;

/** "3:45 pm", or with the date when that isn't today. Lagos time, like every time in the app. */
export const formatUnlock = (iso: string) => (lagosDate(iso) === lagosDate() ? formatTime(iso) : formatDateTime(iso));

/** One line for a locked PIN. */
export const lockedMessage = (until: string | null) =>
  until
    ? `Too many wrong tries, so your PIN is locked until ${formatUnlock(until)}. Reset it now with your password and a code we email you.`
    : "Too many wrong tries, so your PIN is locked for 30 minutes. Reset it now with your password and a code we email you.";
