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
      /** Holds and lockouts (SECURITY_HOLD, NEW_MEMBER_HOLD, STEP_UP_LOCKED): when they end, ISO time. */
      until?: string | null
      /** A wrong step-up code: how many tries are left on it. */
      attemptsLeft?: number
    }
