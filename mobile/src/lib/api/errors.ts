// Error shape from backend/src/middleware/errorHandler.ts: { error, code?, details? }.
// Messages mirror web/src/lib/api/errors.ts; keep the two in step.

type ZodIssue = { path: (string | number)[]; message: string };

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

const MESSAGES: Record<string, string> = {
  NETWORK: "You're offline or the connection dropped. Check your internet and try again.",
  TIMEOUT: "That took too long. Check your connection and try again.",
  // Also what an account with no password gets (see "Forgot password?").
  INVALID_CREDENTIALS: "That email and password don't match. Check them, or reset your password.",
  EMAIL_NOT_VERIFIED: "Verify your email to continue. We've sent you a new code.",
  EMAIL_TAKEN: "An account with this email already exists. Sign in instead.",
  INVALID_CODE: "That code is wrong or has expired. Check it and try again.",
  OTP_COOLDOWN: "Wait a minute before asking for another code.",
  INVALID_TOKEN: "Your sign-in has expired. Start again.",
  UNAUTHENTICATED: "Sign in to continue.",
  INVALID_REFRESH_TOKEN: "Your session has ended. Sign in again.",
  SESSION_REVOKED: "This phone was signed out. Sign in again.",
  SESSION_NOT_FOUND: "That device is already signed out.",
  INVALID_BIOMETRIC_KEY: "Biometric sign-in has ended on this phone. Sign in with your password.",
  DEVICE_SESSION_REQUIRED: "Sign in again on this phone to turn this on.",
  BUSINESS_NOT_APPROVED: "This is available once your business is verified.",
  FORBIDDEN: "You don't have access to this.",
  PROVIDER_ERROR: "We can't reach our banking partner right now. Try again in a moment.",
  PERMISSION_DENIED: "Your role doesn't allow this. Ask an owner or admin.",
  NOT_A_MEMBER: "You're no longer a member of that business.",
  INVALID_BUSINESS_ID: "We couldn't find that business.",
  INSUFFICIENT_BALANCE: "There isn't enough money in this account for this transfer and its fee.",
  NO_APPROVER: "This transfer needs approval, but nobody other than you can approve it at one of its levels. Ask an admin to add an approver.",
  CANNOT_APPROVE_OWN: "Someone else has to approve a transfer you created.",
  NOT_YOUR_LEVEL: "This transfer is waiting for someone at a different approval level.",
  ALREADY_APPROVED: "You approved an earlier level of this transfer, so someone else has to approve this one.",
  TRANSFER_NOT_PENDING: "This transfer is no longer waiting for approval. Refresh to see where it is.",
  ACCOUNT_NOT_FOUND: "We couldn't find that account. Check the number and bank.",
  SAME_ACCOUNT: "You can't send money to the account it's coming from.",
  ACCOUNT_BUSY: "Another transfer from this account is going through. Try again in a moment.",
  INVALID_BANK: "Choose a bank from the list.",
  BUSINESS_REQUIRED: "Set up your business first.",
  BUSINESS_EXISTS: "This account already has a business.",
  KYB_INCOMPLETE: "A few requirements are still missing.",
  UNSUPPORTED_FILE_TYPE: "Upload a PDF, or a photo of the document.",
  FILE_REQUIRED: "Choose a file to upload.",
  LIMIT_FILE_SIZE: "That file is over 5 MB. Upload a smaller file, or take a photo of the page instead.",
  BUSINESS_LOCKED: "Your business is under review, so it can't be edited right now.",
  ACCOUNT_NOT_READY: "Your business account is still being set up.",
  BRANCH_NAME_TAKEN: "You already have a branch with this name. Choose another.",
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
  INVOICE_NOT_FOUND: "We couldn't find that invoice. It may have been deleted.",
  INVOICE_EMPTY: "Add at least one item before sending.",
  CUSTOMER_EMAIL_REQUIRED: "Add the customer's email address, or share the link instead.",
  CUSTOMER_NOT_FOUND: "That customer was removed. Choose another or add them again.",
  PAYMENT_TOO_LARGE: "That's more than the balance due.",
  INVALID_DATES: "The due date can't be before the issue date.",
  INSUFFICIENT_POCKET_BALANCE: "There isn't that much in this pocket.",
  POCKET_NAME_TAKEN: "This branch already has a pocket with that name. Choose another.",
  POCKET_LIMIT: "This branch already has 20 open pockets. Close one before adding another.",
  POCKET_CLOSED: "This pocket is closed, so it can't be changed.",
  SAFELOCK_TOO_SMALL: "That's below the smallest amount you can lock.",
  INVALID_UNLOCK_DATE: "Choose an unlock date inside the allowed range.",
  SAFELOCK_LIMIT: "This branch already has 50 running Safelocks. Wait for one to unlock before adding another.",
  SAFELOCK_RELEASED: "This Safelock has already unlocked, so it can't be renamed.",
  SAFELOCK_NOT_FOUND: "We couldn't find that Safelock. It may be on a branch you can't see.",
  // Payment links (same copy as the web)
  PAYMENT_LINK_NOT_FOUND: "We couldn't find that payment link. It may be on a branch you can't see.",
  PAYMENT_LINK_LIMIT: "You have 500 payment links, the most a business can have. Delete some you no longer use.",
  PAYMENT_LINK_IN_USE: "People have already paid or started paying through this link, so it can't be deleted. Turn it off instead.",
  CHECKOUT_NOT_FOUND: "We couldn't find that payment.",
  CHECKOUT_NOT_PENDING: "This payment has already been matched. Refresh to see it.",
  TRANSACTION_ALREADY_LINKED: "That transfer is already linked to an invoice or another payment.",
  TRANSACTION_NOT_FOUND: "We couldn't find that transfer. Refresh and try again.",
  POCKET_NOT_FOUND: "We couldn't find that pocket. It may be on a branch you can't see.",
  // Passwords (same copy as the web)
  INCORRECT_PASSWORD: "That password is incorrect.",
  PASSWORD_NOT_SET: "You haven't set a password yet. Set one with a code we email you.",
};

/** Maps backend errors (some have no `code`) to short, friendly copy. */
export function friendlyMessage(err: unknown): string {
  if (!(err instanceof ApiError)) return "Something went wrong. Try again.";
  if (err.code && MESSAGES[err.code]) return MESSAGES[err.code];
  if (err.status === 429) return "Too many attempts. Wait a few minutes and try again.";
  if (err.message === "Incorrect password") return "That password is incorrect.";
  if (err.status === 400 && err.message === "Validation failed") return "Check the highlighted fields.";
  if (err.status >= 500) return "Something went wrong on our side. Try again in a moment.";
  return err.message;
}

/** Turns a zod issues array into { "address.street": "message" } for react-hook-form. */
export function fieldErrorsFrom(details: unknown): Record<string, string> | undefined {
  if (!Array.isArray(details)) return undefined;
  const out: Record<string, string> = {};
  for (const issue of details as ZodIssue[]) {
    if (!issue?.path?.length) continue;
    out[issue.path.join(".")] ??= /required|>=?\s*1/i.test(issue.message) ? "This field is required." : issue.message;
  }
  return Object.keys(out).length ? out : undefined;
}
