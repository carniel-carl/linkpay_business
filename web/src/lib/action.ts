import "server-only"
import { redirect, unstable_rethrow } from "next/navigation"
import { ApiError, fieldErrorsFrom, friendlyMessage } from "@/lib/api/errors"
import { clearSession } from "@/lib/session"
import type { ActionResult } from "@/lib/action-result"

/**
 * Runs a Server Action body and converts backend errors into a serialisable result.
 * An expired session clears the cookie and sends the user to sign in.
 */
export async function runAction<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() }
  } catch (err) {
    unstable_rethrow(err)
    if (err instanceof ApiError) {
      if (err.sessionExpired) {
        await clearSession()
        redirect("/sign-in?expired=1")
      }
      const details = err.details as
        | {
            retryAt?: string
            rows?: { row: number; error: string; code?: string; accountName?: string }[]
            attemptsLeft?: number
            lockedUntil?: string
            count?: number
            amountKobo?: number
          }
        | undefined
      return {
        ok: false,
        error: friendlyMessage(err),
        code: err.code,
        fieldErrors: fieldErrorsFrom(err.details),
        missing: err.missing,
        retryAt: details?.retryAt,
        rows: details?.rows,
        attemptsLeft: typeof details?.attemptsLeft === "number" ? details.attemptsLeft : undefined,
        lockedUntil: details?.lockedUntil,
        waitingNow:
          err.code === "BATCH_CHANGED" && typeof details?.count === "number" && typeof details.amountKobo === "number"
            ? { count: details.count, amountKobo: details.amountKobo }
            : undefined,
      }
    }
    console.error(err)
    return { ok: false, error: "Something went wrong on our side. Try again in a moment." }
  }
}
