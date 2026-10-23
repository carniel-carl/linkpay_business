import "server-only"

const PIN_FORMAT = /^\d{4}$/

/**
 * The header a covered request carries the transaction PIN in (docs/briefs/transaction-pin.md). The PIN only
 * ever reaches the server as a Server Action argument and leaves it only in this header: never in a URL, a
 * cookie, a log or an error. Anything that isn't 4 digits is left off, so the API answers
 * TRANSACTION_PIN_MISSING (or _REQUIRED) without using up a try.
 */
export function pinHeader(pin: unknown): Record<string, string> {
  return typeof pin === "string" && PIN_FORMAT.test(pin) ? { "X-Transaction-Pin": pin } : {}
}
