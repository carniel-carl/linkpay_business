import { env } from "../config/env";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface EmailProvider {
  send(message: EmailMessage): Promise<void>;
}

// Default provider until a real email service is wired in: prints emails to the console.
const consoleProvider: EmailProvider = {
  async send({ to, subject, text }) {
    console.log(`\n📧 Email to ${to}\nSubject: ${subject}\n\n${text}\n`);
  },
};

let provider: EmailProvider = consoleProvider;

/** Swap in a real provider (Resend, SES, SendGrid, ...) at startup. */
export function setEmailProvider(next: EmailProvider) {
  provider = next;
}

export function sendEmail(message: EmailMessage) {
  return provider.send(message);
}

const codeEmail = (to: string, subject: string, intro: string, code: string) =>
  sendEmail({
    to,
    subject,
    text: `${intro}\n\nYour code is: ${code}\n\nIt expires in 10 minutes. If you didn't request this, you can ignore this email.`,
    html: `<p>${intro}</p><p style="font-size:24px;font-weight:bold;letter-spacing:4px">${code}</p><p>It expires in 10 minutes. If you didn't request this, you can ignore this email.</p>`,
  });

export const sendVerificationEmail = (to: string, code: string) =>
  codeEmail(to, `Verify your ${env.appName} email`, `Welcome to ${env.appName}! Confirm your email address.`, code);

export const sendLoginCodeEmail = (to: string, code: string) =>
  codeEmail(to, `Your ${env.appName} sign-in code`, `Use this code to sign in to ${env.appName}.`, code);

export const sendTwoFactorCodeEmail = (to: string, code: string) =>
  codeEmail(to, `Your ${env.appName} verification code`, `Use this code to finish signing in to ${env.appName}.`, code);

export const sendBusinessSubmittedEmail = (to: string, businessName: string) =>
  sendEmail({
    to,
    subject: `We've received ${businessName}'s verification documents`,
    text: `Thanks for submitting ${businessName} for verification. Our team will review your documents and get back to you, usually within 1-2 business days.`,
  });

export const sendBusinessApprovedEmail = (to: string, businessName: string, accountNumber?: string) =>
  sendEmail({
    to,
    subject: `${businessName} is approved on ${env.appName}`,
    text:
      `Good news! ${businessName} has been verified. You now have full access to your ${env.appName} dashboard.` +
      (accountNumber ? `\n\nYour business account number is ${accountNumber}. Transfers to it land in your ${env.appName} balance.` : ""),
  });

export const sendBusinessChangesRequestedEmail = (to: string, businessName: string, note: string) =>
  sendEmail({
    to,
    subject: `Action needed: update ${businessName}'s verification`,
    text: `We need a few changes before we can approve ${businessName}:\n\n${note}\n\nSign in to your dashboard to update and resubmit.`,
  });

export const sendBusinessRejectedEmail = (to: string, businessName: string, reason: string) =>
  sendEmail({
    to,
    subject: `Update on ${businessName}'s verification`,
    text: `We were unable to approve ${businessName}.\n\nReason: ${reason}\n\nReply to this email if you have questions.`,
  });

export const sendTeamInviteEmail = (
  to: string,
  { businessName, inviterName, roleLabel, link }: { businessName: string; inviterName: string; roleLabel: string; link: string },
) =>
  sendEmail({
    to,
    subject: `${inviterName} invited you to ${businessName} on ${env.appName}`,
    text:
      `${inviterName} has invited you to join ${businessName} on ${env.appName} as ${roleLabel}.\n\n` +
      `Accept the invite: ${link}\n\nThis link expires in 7 days. If you weren't expecting it, you can ignore this email.`,
    html:
      `<p>${inviterName} has invited you to join <strong>${businessName}</strong> on ${env.appName} as ${roleLabel}.</p>` +
      `<p><a href="${link}">Accept the invite</a></p><p>This link expires in 7 days. If you weren't expecting it, you can ignore this email.</p>`,
  });

/** ₦12,345.67 */
export const formatNaira = (kobo: number) =>
  `₦${(kobo / 100).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const transferSubject = (count: number, amountKobo: number, recipientName?: string) =>
  count === 1 ? `${formatNaira(amountKobo)} to ${recipientName}` : `${count} transfers (${formatNaira(amountKobo)})`;

export const sendTransferAwaitingApprovalEmail = (
  to: string,
  opts: { businessName: string; creatorName: string; amountKobo: number; count: number; recipientName?: string; path: string },
) =>
  sendEmail({
    to,
    subject: `Approve ${transferSubject(opts.count, opts.amountKobo, opts.recipientName)}`,
    text:
      `${opts.creatorName} has prepared ${transferSubject(opts.count, opts.amountKobo, opts.recipientName)} from ${opts.businessName}. ` +
      `The money is held until you approve or reject it.\n\nReview it: ${env.webUrl}${opts.path}`,
  });

export const sendTransferRejectedEmail = (to: string, opts: { amountKobo: number; count: number; recipientName?: string; note?: string }) =>
  sendEmail({
    to,
    subject: `Not approved: ${transferSubject(opts.count, opts.amountKobo, opts.recipientName)}`,
    text:
      `${transferSubject(opts.count, opts.amountKobo, opts.recipientName)} wasn't approved, so no money was sent and the hold was released.` +
      (opts.note ? `\n\nNote from the approver: ${opts.note}` : ""),
  });

export const sendTransferFailedEmail = (to: string, opts: { amountKobo: number; recipientName: string; reason?: string }) =>
  sendEmail({
    to,
    subject: `Transfer failed: ${formatNaira(opts.amountKobo)} to ${opts.recipientName}`,
    text:
      `Your transfer of ${formatNaira(opts.amountKobo)} to ${opts.recipientName} didn't go through` +
      (opts.reason ? `: ${opts.reason}.` : ".") +
      ` Any money taken from the account is returned.`,
  });
