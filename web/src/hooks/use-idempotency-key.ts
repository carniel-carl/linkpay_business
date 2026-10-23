import { useRef } from "react"

const newKey = () => crypto.randomUUID().replaceAll("-", "")

/**
 * The Idempotency-Key for a request that moves money. The key belongs to what's being sent, not to an
 * attempt: the same details get the same key, so sending again after any error (a refusal, a dropped
 * response, a 5xx, the banking partner being down) can't move money twice. If the first try got through,
 * the server replays it; a refusal isn't stored under the key, so a retry after fixing the cause (say,
 * topping up) is checked again. Changing anything that's sent gets a new key, and `reset()` after a
 * success makes the next request a new one.
 */
export function useIdempotencyKey() {
  // A ref, not state: a second click before the re-render still sees the key the first one made.
  const current = useRef<{ request: string; key: string } | null>(null)
  return {
    /** The key for these details: everything that's sent apart from the key itself. */
    keyFor(request: unknown) {
      const fingerprint = JSON.stringify(request)
      if (current.current?.request !== fingerprint) current.current = { request: fingerprint, key: newKey() }
      return current.current.key
    },
    reset() {
      current.current = null
    },
  }
}
