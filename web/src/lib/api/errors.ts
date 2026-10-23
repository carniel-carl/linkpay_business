// Error shape from backend/src/middleware/errorHandler.ts: { error, code?, details? }.
import { WEAK_PIN_MESSAGE, wrongPinMessage } from "@/lib/transaction-pin"
import type { ChecklistItem } from "./types"

type ZodIssue = { path: (string | number)[]; message: string }

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public details?: unknown,
    public missing?: ChecklistItem[],
    /** True when the request carried the session token. */
    public authed = false,
  ) {
    super(message)
  }

  /** The session token was missing, expired, signed out elsewhere or invalid (not a wrong password). */
  get sessionExpired() {
    if (this.status !== 401) return false
    return this.code === "UNAUTHENTICATED" || (this.authed && (this.code === "INVALID_TOKEN" || this.code === "SESSION_REVOKED"))
  }
}

const MESSAGES: Record<string, string> = {
  // Also what an account with no password gets (see "Forgot password?").
  INVALID_CREDENTIALS: "That email and password don't match. Check them, or reset your password.",
  EMAIL_NOT_VERIFIED: "Verify your email to continue. We've sent you a new code.",
  EMAIL_TAKEN: "An account with this email already exists. Sign in instead.",
  INVALID_CODE: "That code is wrong or has expired. Check it and try again.",
  OTP_COOLDOWN: "Wait a minute before asking for another code.",
  INVALID_TOKEN: "Your sign-in has expired. Start again.",
  UNAUTHENTICATED: "Sign in to continue.",
  BUSINESS_EXISTS: "This account already has a business.",
  BUSINESS_REQUIRED: "Set up your business first.",
  BUSINESS_LOCKED: "Your business is under review, so it can't be edited right now.",
  BUSINESS_NOT_APPROVED: "This is available once your business is verified.",
  KYB_INCOMPLETE: "A few requirements are still missing.",
  UNSUPPORTED_FILE_TYPE: "Upload a PDF, PNG or JPEG file.",
  FILE_REQUIRED: "Choose a file to upload.",
  NOT_REVIEWABLE: "This business is no longer waiting for review. Refresh to see its current status.",
  FORBIDDEN: "You don't have access to this.",
  PROVIDER_ERROR: "We can't reach our banking partner right now. Try again in a moment.",
  ACCOUNT_NOT_READY: "Your business account is still being set up.",
  BRANCH_NAME_TAKEN: "You already have a branch with this name. Choose another.",
  NOT_APPROVED: "Only approved businesses can have an account.",
  // Team
  PERMISSION_DENIED: "Your role doesn't allow this. Ask an owner or admin.",
  NOT_A_MEMBER: "You're no longer a member of that business. Refresh to continue.",
  INVALID_BUSINESS_ID: "We couldn't find that business. Refresh to continue.",
  ALREADY_MEMBER: "This person is already on your team.",
  INVITE_EXISTS: "This person already has a pending invite. Resend it instead.",
  INVITE_COOLDOWN: "You've just sent this invite. Wait a minute before sending it again.",
  INVITE_CLOSED: "This invite is no longer open.",
  INVITE_EXPIRED: "This invite has expired. Ask for a new one.",
  INVITE_NOT_FOUND: "This invite link isn't valid. Ask for a new one.",
  INVITE_EMAIL_MISMATCH: "This invite is for a different email. Sign in with the invited email to accept it.",
  OWNER_ONLY: "Only the business owner can add, change or remove admins.",
  CANNOT_MODIFY_OWNER: "The owner's access can't be changed.",
  CANNOT_MODIFY_SELF: "You can't change your own access. Ask the owner or another admin.",
  OWNER_CANNOT_LEAVE: "The owner can't leave the business.",
  INVALID_BRANCH: "One of those branches isn't part of this business. Refresh and try again.",
  // Transfers
  INSUFFICIENT_BALANCE: "There isn't enough money in this account for this transfer and its fee.",
  ACCOUNT_NOT_FOUND: "We couldn't find that account. Check the number and bank.",
  INVALID_BANK: "Choose a bank from the list.",
  SAME_ACCOUNT: "You can't send money to the account it's coming from.",
  NO_APPROVER: "This transfer needs approval, but nobody other than you can approve it at one of its levels. Ask an admin to add an approver.",
  TRANSFER_NOT_PENDING: "This transfer is no longer waiting for approval. Refresh to see where it is.",
  CANNOT_APPROVE_OWN: "Someone else has to approve a transfer you created.",
  NOT_YOUR_LEVEL: "This transfer is waiting for someone at a different approval level.",
  ALREADY_APPROVED: "You approved an earlier level of this transfer, so someone else has to approve this one.",
  INVALID_APPROVER: "One of the approvers can no longer approve transfers. Remove them and save again.",
  DUPLICATE_APPROVER: "The same person can't be at two levels of one amount band.",
  INVALID_APPROVAL_RULE: "Two amount bands start at the same amount. Change one of them.",
  ACCOUNT_BUSY: "Another transfer from this account is going through. Try again in a moment.",
  RECIPIENT_BANK_UNKNOWN: "We can't send to this account's bank automatically yet. Contact support.",
  INVALID_ROWS: "Some rows need fixing before anything is sent.",
  // Savings pockets
  INSUFFICIENT_POCKET_BALANCE: "There isn't that much in this pocket.",
  POCKET_NAME_TAKEN: "This branch already has a pocket with that name. Choose another.",
  POCKET_LIMIT: "This branch already has 20 open pockets. Close one before adding another.",
  POCKET_CLOSED: "This pocket is closed, so it can't be changed.",
  POCKET_NOT_FOUND: "We couldn't find that pocket. It may be on a branch you can't see.",
  INVALID_DATES: "Choose a date in the future.",
  // Safelock
  SAFELOCK_TOO_SMALL: "That's below the smallest amount you can lock.",
  INVALID_UNLOCK_DATE: "Choose an unlock date inside the allowed range.",
  SAFELOCK_LIMIT: "This branch already has 50 running Safelocks. Wait for one to unlock before adding another.",
  SAFELOCK_RELEASED: "This Safelock has already unlocked, so it can't be renamed.",
  SAFELOCK_NOT_FOUND: "We couldn't find that Safelock. It may be on a branch you can't see.",
  // Payment links
  PAYMENT_LINK_NOT_FOUND: "We couldn't find that payment link. It may be on a branch you can't see.",
  PAYMENT_LINK_LIMIT: "You have 500 payment links, the most a business can have. Delete some you no longer use.",
  PAYMENT_LINK_IN_USE: "People have already paid or started paying through this link, so it can't be deleted. Turn it off instead.",
  PAYMENT_LINK_UNAVAILABLE: "This payment link isn't taking payments right now.",
  PAYMENT_LINK_IMAGE_LIMIT: "A payment link can have up to 4 pictures. Remove one to add another.",
  IMAGE_NOT_FOUND: "One of the pictures has expired or was removed. Take it off and upload it again.",
  FILE_TOO_LARGE: "That file is over 5 MB. Use a smaller one.",
  IMAGE_TOO_SMALL: "That picture is too small. Use one at least 64 pixels wide or tall.",
  CHECKOUT_NOT_FOUND: "We couldn't find that payment.",
  CHECKOUT_NOT_PENDING: "This payment has already been matched. Refresh to see it.",
  TRANSACTION_ALREADY_LINKED: "That transfer is already linked to an invoice or another payment.",
  TRANSACTION_NOT_FOUND: "We couldn't find that transfer. Refresh and try again.",
  CHECKOUT_BUSY: "Lots of people are paying this amount right now. Try again in a few minutes.",
  EMBED_NOT_ALLOWED: "This payment link can't be used on this website.",
  TOO_MANY_CHECKOUTS: "Too many attempts. Wait a few minutes and try again.",
  FIELD_REQUIRED: "Fill in the required fields.",
  // Passwords
  INCORRECT_PASSWORD: "That password is incorrect.",
  PASSWORD_NOT_SET: "You haven't set a password yet. Set one with a code we email you.",
  // Transaction PIN (docs/briefs/transaction-pin.md)
  TRANSACTION_PIN_REQUIRED: "Set a transaction PIN first. You'll use it to confirm transfers, approvals and team changes.",
  TRANSACTION_PIN_MISSING: "Enter your 4-digit transaction PIN.",
  TRANSACTION_PIN_LOCKED: "Your transaction PIN is locked after too many wrong tries. Reset it, or wait and try again.",
  TRANSACTION_PIN_ALREADY_SET: "You already have a transaction PIN. Change it instead.",
  WEAK_TRANSACTION_PIN: WEAK_PIN_MESSAGE,
  // Beneficiaries and payout lists (docs/briefs/bulk-payouts.md)
  BENEFICIARY_EXISTS: "This account is already saved as a beneficiary.",
  BENEFICIARY_OWN_ACCOUNT: "This is one of your own branch accounts. Move money to it as a branch transfer instead.",
  BENEFICIARY_NOT_FOUND: "We couldn't find that beneficiary. It may have been removed. Refresh and try again.",
  BENEFICIARY_IN_USE: "A payout list still pays this beneficiary. Take them off the list first.",
  BENEFICIARY_LIMIT: "You have 2,000 saved beneficiaries, the most a business can have. Remove some to add more.",
  PAYOUT_LIST_NOT_FOUND: "We couldn't find that payout list. It may have been deleted, or be for a branch you can't see.",
  PAYOUT_LIST_LIMIT: "You have 100 payout lists, the most a business can have. Delete one to add another.",
  PAYOUT_LIST_EMPTY: "This bulk transfer only went to your own branches, so there's nobody to save as a list.",
  BRANCH_REQUIRED: "Choose the account to pay from.",
  IDEMPOTENCY_KEY_REUSED: "These payment details changed after they were first sent. Check Transfers to see whether it went before sending it again.",
  // The bank answered a name check without a name (502, and a per-row code): a passing outage, not a wrong account.
  NAME_CHECK_UNAVAILABLE: "We couldn't check this account with the bank right now. Try again in a moment.",
}

/** Friendly copy for an error code reported inside a response (a bulk row's), or the server's own message. */
export const messageForCode = (code: string | undefined, fallback: string) => (code && MESSAGES[code]) || fallback

/** Maps backend errors (some have no `code`) to short, friendly copy. */
export function friendlyMessage(err: ApiError): string {
  if (err.code === "TRANSACTION_PIN_INVALID") return wrongPinMessage((err.details as { attemptsLeft?: number } | undefined)?.attemptsLeft)
  if (err.code && MESSAGES[err.code]) return MESSAGES[err.code]
  if (err.status === 429) return "Too many attempts. Wait a few minutes and try again."
  if (err.message === "Incorrect password") return "That password is incorrect."
  if (err.message === "File too large") return "That file is over 5 MB. Upload a smaller file."
  if (err.status === 400 && err.message === "Validation failed") return "Check the highlighted fields."
  if (err.status >= 500) return "Something went wrong on our side. Try again in a moment."
  return err.message
}

/** Turns a zod issues array into { "address.street": "message" } for react-hook-form. */
export function fieldErrorsFrom(details: unknown): Record<string, string> | undefined {
  if (!Array.isArray(details)) return undefined
  const out: Record<string, string> = {}
  for (const issue of details as ZodIssue[]) {
    if (!issue?.path?.length) continue
    const key = issue.path.join(".")
    out[key] ??= tidyZodMessage(issue.message)
  }
  return Object.keys(out).length ? out : undefined
}

function tidyZodMessage(message: string) {
  if (/expected string to have >=?\s*1/i.test(message) || /required/i.test(message)) return "This field is required."
  if (/invalid email/i.test(message)) return "Enter a valid email address."
  if (/invalid url/i.test(message)) return "Enter a full web address, like https://example.ng"
  return message
}
