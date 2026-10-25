// The transaction PIN's rules, shared by the browser and the server actions. Contract: docs/briefs/transaction-pin.md.
import { formatDate, formatDateTime, formatTime } from "@/lib/format"

export const PIN_LENGTH = 4

/**
 * The most common PINs the rules in isWeakPin don't already catch: pairs and mirrors (1212, 1122, 1221), keypad
 * shapes (2580, 1379, 7890) and PINs with a meaning (1004, 6969, 5683). The same list as COMMON_PINS in
 * backend/src/services/transactionPin.ts.
 */
const COMMON_PINS: ReadonlySet<string> = new Set([
  "0101", "1010", "1212", "1313", "1414", "1515", "2121", "2323", "2525", "4545", "6969",
  "0011", "1100", "1122", "2211",
  "0110", "1001", "1221", "2112",
  "0741", "0852", "0963", "1470", "2580", "3690", "1379", "1397", "7913", "9731", "1590", "3570", "2468", "7890", "0987",
  "0007", "1004", "5683",
])

/**
 * 0000, 1111 …, straight runs up or down (1234, 9876, 0123), years from 1950 to 2030, and COMMON_PINS: the first
 * PINs anyone would try. Mirrors isWeakPin in backend/src/services/transactionPin.ts, which refuses them with
 * WEAK_TRANSACTION_PIN.
 */
export function isWeakPin(pin: string) {
  const digits = [...pin].map(Number)
  const steps = new Set(digits.slice(1).map((d, i) => d - digits[i]))
  if (steps.size === 1 && [0, 1, -1].includes([...steps][0])) return true
  const asYear = Number(pin)
  return (asYear >= 1950 && asYear <= 2030) || COMMON_PINS.has(pin)
}

export const WEAK_PIN_MESSAGE = "That PIN is too easy to guess. Avoid repeated digits, runs like 1234, years and other common PINs."

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
