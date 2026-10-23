// The transaction PIN's rules, shared by the browser and the server actions. Contract: docs/briefs/transaction-pin.md.
import { formatDate, formatDateTime, formatTime } from "@/lib/format"

export const PIN_LENGTH = 4

/**
 * 0000, 1111 … and straight runs up or down (1234, 9876, 0123): the first PINs anyone would try.
 * Mirrors isWeakPin in backend/src/services/transactionPin.ts, which refuses them with WEAK_TRANSACTION_PIN.
 */
export function isWeakPin(pin: string) {
  const digits = [...pin].map(Number)
  const steps = new Set(digits.slice(1).map((d, i) => d - digits[i]))
  return steps.size === 1 && [0, 1, -1].includes([...steps][0])
}

export const WEAK_PIN_MESSAGE = "That PIN is too easy to guess. Avoid repeated digits and runs like 1234."

/** What a covered request answers when the PIN is the problem. Any other answer is the action's own. */
const PIN_ERRORS = new Set(["TRANSACTION_PIN_REQUIRED", "TRANSACTION_PIN_MISSING", "TRANSACTION_PIN_INVALID", "TRANSACTION_PIN_LOCKED"])

export const isPinError = (code?: string) => !!code && PIN_ERRORS.has(code)

/** "Wrong PIN. 3 tries left." */
export function wrongPinMessage(attemptsLeft?: number) {
  if (!attemptsLeft) return "Wrong PIN. Check it and try again."
  return `Wrong PIN. ${attemptsLeft} ${attemptsLeft === 1 ? "try" : "tries"} left.`
}

/** "at 3:45 pm" when the lock ends today, otherwise "on 24 Oct 2026, 3:45 pm". Lagos time. Browser only (it reads the clock). */
export function unlocksAt(iso: string) {
  return formatDate(iso) === formatDate(new Date().toISOString()) ? `at ${formatTime(iso)}` : `on ${formatDateTime(iso)}`
}
