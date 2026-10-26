// Money-out protection: how money leaving a business is guarded against a stolen login.
// Contract and the research behind these numbers: docs/briefs/money-out-security.md. Tune them here only.

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

export const SECURITY = {
  /** A step-up code (transaction signing) must be used within this long of asking for it. */
  stepUpTtlMs: 5 * MINUTE,
  /** Wrong codes allowed on one step-up before it's dead. */
  stepUpMaxAttempts: 5,
  /** Emailed step-up codes a person can ask for in `stepUpWindowMs` (authenticator users aren't limited: nothing is sent). */
  stepUpStartLimit: 30,
  stepUpWindowMs: 15 * MINUTE,
  /** This many wrong step-up codes in `stepUpWindowMs` locks the person out of moving money for `stepUpLockMs`. */
  stepUpFailureLimit: 5,
  stepUpLockMs: HOUR,

  /** After a two-step (2FA) change, the person can't move money or change protection for this long. */
  twoFactorHoldMs: 24 * HOUR,
  /** A new team member, or one given a role that moves money, waits this long before they can. */
  newMemberHoldMs: 24 * HOUR,

  /** A new settlement account can't be used until this long after it was added, even once staff approve it. */
  settlementCoolingOffMs: 24 * HOUR,
  /** Turning off "settlement accounts only" takes effect this long after it's asked for (and staff approve). */
  lockRemovalCoolingOffMs: 72 * HOUR,
  /** Settlement accounts per business (active and waiting). */
  maxSettlementAccounts: 3,

  /** "This wasn't me" links in security emails work for this long. */
  reportLinkTtlMs: 30 * 24 * HOUR,
  /** How often waiting requests are checked for the end of their cooling-off. */
  requestCheckIntervalMs: MINUTE,
} as const;

/**
 * Name check of a settlement account against the business. Scores are 0..1 (shared words, see
 * services/nameMatch.ts). Below `partial` the account is refused; between the two it goes to staff marked
 * as a partial match.
 */
export const NAME_MATCH = { match: 0.8, partial: 0.5 } as const;

/**
 * Business types that may settle into an owner's or partner's personal account (as a sole trader does).
 * Companies, cooperatives and trustees must use an account in the business's own name; a director's
 * personal account counts as a partial match that staff look at.
 */
export const PERSONAL_SETTLEMENT_TYPES = ["sole_proprietorship", "partnership"] as const;
/** Whose personal account a sole trader or partnership may use. */
export const PERSONAL_SETTLEMENT_ROLES = ["owner", "partner"] as const;

/**
 * Everything that needs a fresh second-factor code (step-up) bound to exactly what is being done.
 * The code is tied to the action and its details (amount, recipient, ...), so it can't be reused for anything else.
 */
export const STEP_UP_ACTIONS = [
  "transfer.create",
  "transfer.bulk",
  "transfer.approve",
  "batch.approve",
  "payout_list.run",
  "settlement.add",
  "settlement.remove",
  "settlement.withdraw",
  "settlement_only.enable",
  "settlement_only.disable",
  "money_out.unfreeze",
] as const;
export type StepUpAction = (typeof STEP_UP_ACTIONS)[number];
