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
      /** When a rate-limited action (OTP_COOLDOWN) can be tried again, ISO time. */
      retryAt?: string
    }
