// Error shape from backend/src/middleware/errorHandler.ts: { error, code?, details? }.
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

  /** The session token was missing, expired or invalid (not a wrong password). */
  get sessionExpired() {
    if (this.status !== 401) return false
    return this.code === "UNAUTHENTICATED" || (this.authed && (this.code === "INVALID_TOKEN" || this.code === "SESSION_REVOKED"))
  }
}

const MESSAGES: Record<string, string> = {
  INVALID_CREDENTIALS: "That email and password don't match. Check them and try again.",
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
  // Money-out security: step-up codes
  STEP_UP_REQUIRED: "Confirm this with a code first.",
  STEP_UP_EXPIRED: "That code has expired. Send a new one.",
  STEP_UP_USED: "That code has already been used. Send a new one.",
  STEP_UP_MISMATCH: "The details changed after we sent the code. Send a new one.",
  STEP_UP_LIMIT: "You've asked for a lot of codes. Wait a few minutes and try again.",
  STEP_UP_LOCKED: "Too many wrong codes, so you can't send money for an hour. If this wasn't you, freeze money out and contact support.",
  INVALID_STEP_UP: "Check the details and try again.",
  // Money-out security: holds and protection
  MONEY_OUT_FROZEN: "Money leaving this business is frozen. Nothing can be sent or withdrawn until it's unfrozen.",
  SECURITY_HOLD: "For your safety you can't send money for 24 hours after a two-step verification change.",
  NEW_MEMBER_HOLD: "New team members can't send or approve money for their first 24 hours.",
  SETTLEMENT_ONLY: "This business only allows withdrawals to its settlement accounts and transfers between its own branches.",
  UNFREEZE_NEEDS_SUPPORT: "LinkPay froze money out to protect your business. Contact support to have it checked and unfrozen.",
  NOT_FROZEN: "Money out isn't frozen.",
  SETTLEMENT_ONLY_OFF: "\"Settlement accounts only\" isn't on.",
  REQUEST_EXISTS: "There's already a request to turn this off.",
  REQUEST_NOT_FOUND: "There's no request to cancel. Refresh to see the latest.",
  // Settlement accounts
  SETTLEMENT_OWN_ACCOUNT: "This is one of your LinkPay accounts. A settlement account is your account at another bank.",
  SETTLEMENT_LINKPAY_ACCOUNT: "This account belongs to another business on LinkPay. A settlement account must be your own.",
  TWO_FACTOR_REQUIRED: "Turn on two-step verification under Settings, Security before adding a settlement account.",
  INCORRECT_PASSWORD: "That password is incorrect.",
  SETTLEMENT_EXISTS: "This account is already a settlement account, or waiting for review.",
  SETTLEMENT_LIMIT: "You can have up to 3 settlement accounts. Remove one to add another.",
  SETTLEMENT_NOT_PENDING: "Only accounts waiting for review can be cancelled.",
  SETTLEMENT_NOT_ACTIVE: "This settlement account isn't ready for withdrawals.",
  SETTLEMENT_NOT_FOUND: "We couldn't find that settlement account. Refresh and try again.",
  SETTLEMENT_NAME_CHANGED: "The bank now shows a different name on this account, so we've stopped this withdrawal. Contact support.",
  // "This wasn't me" links
  REPORT_NOT_FOUND: "This link isn't valid. Contact support if you're worried about your account.",
  REPORT_USED: "This has already been reported. We've frozen money leaving the business and will be in touch.",
  REPORT_EXPIRED: "This link has expired. Contact support if you're worried about your account.",
  TOO_MANY_REPORTS: "Too many attempts. Try again later or contact support.",
}

/** Maps backend errors (some have no `code`) to short, friendly copy. */
export function friendlyMessage(err: ApiError): string {
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
