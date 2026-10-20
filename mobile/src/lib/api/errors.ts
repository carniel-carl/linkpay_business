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
  INVALID_CREDENTIALS: "That email and password don't match. Check them and try again.",
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
  NO_APPROVER: "This transfer needs approval, but nobody else on your team can approve transfers from this branch. Invite an approver first.",
  CANNOT_APPROVE_OWN: "Someone else has to approve a transfer you created.",
  TRANSFER_NOT_PENDING: "This transfer is no longer waiting for approval. Refresh to see where it is.",
  ACCOUNT_NOT_FOUND: "We couldn't find that account. Check the number and bank.",
  SAME_ACCOUNT: "You can't send money to the account it's coming from.",
  ACCOUNT_BUSY: "Another transfer from this account is going through. Try again in a moment.",
  INVALID_BANK: "Choose a bank from the list.",
  BUSINESS_REQUIRED: "Set up your business first.",
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
