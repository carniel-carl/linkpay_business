import type { ChecklistItem } from "@/lib/api/types"

export type ActionResult<T = void> =
  | { ok: true; data: T }
  | {
      ok: false
      error: string
      code?: string
      /** Keyed by form field path, e.g. "address.street". */
      fieldErrors?: Record<string, string>
      /** Present on KYB_INCOMPLETE. */
      missing?: ChecklistItem[]
      /** When a rate-limited action (INVITE_COOLDOWN) can be tried again, ISO time. */
      retryAt?: string
      /** Bulk transfers (INVALID_ROWS): what's wrong with each row, by index. */
      rows?: { row: number; error: string; code?: string }[]
      /** TRANSACTION_PIN_INVALID: tries left before the PIN locks (1 to 4). */
      attemptsLeft?: number
      /** TRANSACTION_PIN_LOCKED: when the PIN can be used again, ISO time. */
      lockedUntil?: string
    }
