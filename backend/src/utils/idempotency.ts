import { createHash } from "node:crypto";
import { HttpError } from "./HttpError";

/**
 * A fingerprint of what a request asks for, stored next to its Idempotency-Key so that a key reused for a
 * different request is refused instead of quietly replaying the first one. Build `value` in a fixed shape
 * (fields in the same order every time, ids as strings) so the same request always hashes the same.
 */
export const requestHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/**
 * Refuses to replay a key that was first used for a different request. Records from before hashes replay as
 * before. `hash` can list several: the request in each shape a stored record may have (when a hash's shape
 * changed, the old one is accepted for records made before).
 */
export function assertSameRequest(stored: string | null | undefined, hash: string | readonly string[] | undefined) {
  const accepted = typeof hash === "string" ? [hash] : (hash ?? []);
  if (stored && accepted.length && !accepted.includes(stored)) {
    throw new HttpError(
      422,
      "This Idempotency-Key was already used for a different request. Send a new key for a new request.",
      "IDEMPOTENCY_KEY_REUSED",
    );
  }
}

/** A duplicate-key error on an Idempotency-Key index: another request with the same key got there first. */
export const isDuplicateClientKey = (err: any) =>
  err?.code === 11000 && ("clientKey" in (err.keyPattern ?? {}) || /clientKey/.test(String(err.message)));
