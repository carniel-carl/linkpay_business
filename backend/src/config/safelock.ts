// Safelock limits (product owner, 2026-10-21: a lock can never be broken early; no interest at launch).
// The day range and minimum follow PiggyVest's Safelock and are still to be confirmed (open question 15).

/** Shortest and longest lock, in days from today (Lagos). */
export const SAFELOCK_MIN_DAYS = 10;
export const SAFELOCK_MAX_DAYS = 1000;
/** Smallest amount that can be locked: ₦1,000. */
export const SAFELOCK_MIN_AMOUNT_KOBO = 1_000_00;
/** Largest single lock: ₦100m (the available balance is the real limit). */
export const SAFELOCK_MAX_AMOUNT_KOBO = 100_000_000_00;
/** Locks running at once on one branch. */
export const SAFELOCK_MAX_PER_BRANCH = 50;
/** How often the server releases locks whose unlock day has come. */
export const SAFELOCK_RELEASE_INTERVAL_MS = 5 * 60 * 1000;
