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

  /**
   * The staff session is over: no token, an expired or revoked one, or a disabled account. Not a wrong
   * password, and not a bad sign-in challenge (that request carries no session token).
   */
  /** Why the session ended, for the sign-in page: `disabled` or `no_role`, else nothing. */
  get endReason() {
    if (this.code === "STAFF_DISABLED") return "disabled"
    if (this.code === "STAFF_NO_ROLE") return "no_role"
    return undefined
  }

  get sessionExpired() {
    if (!this.authed && this.code !== "UNAUTHENTICATED") return false
    if (this.status === 403) return this.code === "STAFF_DISABLED" || this.code === "STAFF_NO_ROLE"
    if (this.status !== 401) return false
    return this.code === "UNAUTHENTICATED" || this.code === "INVALID_STAFF_TOKEN" || this.code === "STAFF_SESSION_ENDED"
  }
}

const MESSAGES: Record<string, string> = {
  INVALID_CREDENTIALS: "That email and password don't match. Check them and try again.",
  INVALID_CODE: "That code is wrong or has expired. Check it and try again.",
  OTP_COOLDOWN: "Wait a minute before asking for another code.",
  INVALID_STAFF_TOKEN: "Your sign-in has expired. Start again.",
  STAFF_SESSION_ENDED: "Your session ended. Sign in again.",
  STAFF_DISABLED: "This staff account is turned off. Ask another member of staff to turn it back on.",
  UNAUTHENTICATED: "Sign in to continue.",
  INCORRECT_PASSWORD: "That password is incorrect.",
  NOT_EMAIL_METHOD: "Use the code from your authenticator app.",
  TOTP_SETUP_REQUIRED: "Start the authenticator setup again.",
  TOTP_NOT_ENABLED: "Recovery codes only work with the authenticator app. Set it up first.",
  NOT_REVIEWABLE: "This business is no longer waiting for review. Refresh to see its current status.",
  FORBIDDEN: "You don't have access to this.",
  PROVIDER_ERROR: "We can't reach our banking partner right now. Try again in a moment.",
  NOT_APPROVED: "Only approved businesses can have an account.",
  STAFF_NO_ROLE: "Your staff account has no role yet. Ask a super admin to give you one, then sign in again.",
  STAFF_PERMISSION_DENIED: "Your staff role doesn't allow this. Ask a super admin if you need it.",
  STAFF_NOT_FOUND: "That staff member no longer exists. Refresh the page.",
  CANNOT_MODIFY_SELF: "You can't change your own access. Ask another super admin.",
  LAST_SUPER_ADMIN: "There must always be at least one active super admin. Make someone else a super admin first.",
  INVALID_ROLE: "Choose a role.",
  ALREADY_STAFF: "This person is already a member of staff.",
  INVITE_EXISTS: "This person already has an open invite. Resend it from Pending invites instead.",
  INVITE_COOLDOWN: "This invite was sent moments ago. Wait a minute before resending it.",
  INVITE_NOT_FOUND: "This invite link isn't valid. Ask for a new one.",
  INVITE_EXPIRED: "This invite has expired. Ask for a new one.",
  INVITE_CLOSED: "This invite has already been used or was cancelled.",
  INVITER_CANT_INVITE: "The person who invited you can no longer add staff, so this invite no longer works. Ask a super admin for a new one.",
  FLAG_NOT_FOUND: "That flag no longer exists. Refresh the page.",
  FLAG_NOT_OPEN: "Someone has already resolved this flag. Refresh to see their note.",
  INVALID_EVIDENCE: "Some of the chosen payments or transfers don't belong to this business.",
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
