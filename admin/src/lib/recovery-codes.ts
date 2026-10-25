import { formatDate } from "@/lib/format"

/**
 * Set by the sign-in action after a recovery code was used, holding how many are left. Readable by the page (not
 * httpOnly) so the console can show one notice and delete it; a count is all it carries, and it lives 10 minutes.
 * A different name from the business web's, like the session cookies.
 */
export const RECOVERY_NOTICE_COOKIE = "lp_staff_recovery_notice"
export const RECOVERY_NOTICE_MAX_AGE = 10 * 60

/** At or below this many, settings warn that the codes are running out. */
export const FEW_RECOVERY_CODES = 2

/** The .txt a staff member downloads to keep their codes. */
export function recoveryCodesFile(codes: string[], email: string) {
  return [
    "LinkPay Staff recovery codes",
    `For ${email}, made on ${formatDate(new Date().toISOString())}`,
    "",
    "Use one of these to sign in to the staff console when you can't use your authenticator app.",
    "Each code works once. Getting new codes stops these from working.",
    "",
    ...codes,
    "",
  ].join("\n")
}
