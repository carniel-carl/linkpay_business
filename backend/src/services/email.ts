import { env } from "../config/env";

export interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Replies go here instead of the sending address (e.g. invoices reply to the business). */
  replyTo?: string;
  attachments?: EmailAttachment[];
}

export interface EmailProvider {
  send(message: EmailMessage): Promise<void>;
}

// Default provider until a real email service is wired in: prints emails to the console.
const consoleProvider: EmailProvider = {
  async send({ to, subject, text, attachments }) {
    const files = attachments?.length ? `\nAttachments: ${attachments.map((a) => `${a.filename} (${a.content.length} bytes)`).join(", ")}\n` : "";
    console.log(`\n📧 Email to ${to}\nSubject: ${subject}\n\n${text}\n${files}`);
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

// Restriction emails say what the business can and can't do, never why: details of an investigation
// aren't shared with the business.
export const sendBusinessSuspendedEmail = (to: string, businessName: string) =>
  sendEmail({
    to,
    subject: `${businessName}'s ${env.appName} account is suspended`,
    text:
      `We've temporarily suspended ${businessName} while we review its account.\n\n` +
      `While it's suspended you can sign in and see your balances and payments, but you can't send money, ` +
      `create invoices or change settings. Payments into your account still arrive.\n\n` +
      `Reply to this email or contact support to find out more.`,
  });

export const sendBusinessReinstatedEmail = (to: string, businessName: string) =>
  sendEmail({
    to,
    subject: `${businessName} has full access again`,
    text: `We've finished our review and lifted the suspension on ${businessName}. You have full access to your ${env.appName} dashboard again.`,
  });

export const sendBusinessBannedEmail = (to: string, businessName: string) =>
  sendEmail({
    to,
    subject: `${businessName}'s ${env.appName} account is closed`,
    text:
      `We've closed ${businessName}'s ${env.appName} account. You can no longer use it to send or receive money.\n\n` +
      `Contact support about any money left in the account.`,
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

export const sendStaffInviteEmail = (to: string, { inviterName, roleLabel, link }: { inviterName: string; roleLabel: string; link: string }) =>
  sendEmail({
    to,
    subject: `${inviterName} invited you to the ${env.appName} admin console`,
    text:
      `${inviterName} has invited you to join the ${env.appName} admin console as ${roleLabel}.\n\n` +
      `Set up your staff account: ${link}\n\nThis link expires in 7 days. If you weren't expecting it, you can ignore this email.`,
    html:
      `<p>${inviterName} has invited you to join the ${env.appName} admin console as <strong>${roleLabel}</strong>.</p>` +
      `<p><a href="${link}">Set up your staff account</a></p><p>This link expires in 7 days. If you weren't expecting it, you can ignore this email.</p>`,
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

// ---------------------------------------------------------------------------------------------------------
// Money-out protection. Every change that loosens where money can go is emailed to the owner and admins,
// with a personal "This wasn't me" link that stops it. Codes say exactly what they confirm.
// ---------------------------------------------------------------------------------------------------------

/** A step-up code. The summary is what it confirms, so a code tricked out of someone shows what it's for. */
export const sendStepUpCodeEmail = (to: string, { summary, code }: { summary: string; code: string }) =>
  sendEmail({
    to,
    subject: `${env.appName} code to confirm: ${summary}`,
    text:
      `You asked to: ${summary}\n\nYour code is: ${code}\n\nIt expires in 5 minutes and only works for exactly this. ` +
      `Only enter it if you're doing this yourself. ${env.appName} staff will never ask you for it.`,
    html:
      `<p>You asked to: <strong>${escapeHtml(summary)}</strong></p>` +
      `<p style="font-size:24px;font-weight:bold;letter-spacing:4px">${code}</p>` +
      `<p>It expires in 5 minutes and only works for exactly this. Only enter it if you're doing this yourself. ${env.appName} staff will never ask you for it.</p>`,
  });

/**
 * A security notice. `reportLink` adds "This wasn't me": opening it shows what happened and lets the
 * person stop it (the page asks them to confirm, so email scanners following links can't trigger it).
 */
export const sendSecurityEmail = (
  to: string,
  { subject, intro, details = [], outro, reportLink }: { subject: string; intro: string; details?: string[]; outro?: string; reportLink?: string },
) =>
  sendEmail({
    to,
    subject,
    text:
      `${intro}\n` +
      (details.length ? `\n${details.map((d) => `- ${d}`).join("\n")}\n` : "") +
      (outro ? `\n${outro}\n` : "") +
      (reportLink ? `\nIf this wasn't you or anyone on your team, stop it now: ${reportLink}\nThis also freezes money leaving the business until we've spoken to you.\n` : ""),
    html:
      `<p>${escapeHtml(intro)}</p>` +
      (details.length ? `<ul>${details.map((d) => `<li>${escapeHtml(d)}</li>`).join("")}</ul>` : "") +
      (outro ? `<p>${escapeHtml(outro)}</p>` : "") +
      (reportLink
        ? `<p><strong>If this wasn't you or anyone on your team:</strong> <a href="${reportLink}">This wasn't me, stop it</a>. This also freezes money leaving the business until we've spoken to you.</p>`
        : ""),
  });

// ---------------------------------------------------------------------------------------------------------
// Invoices. Customer emails come from the business (its name, accent colour and logo, replies to its email).
// ---------------------------------------------------------------------------------------------------------

export type InvoiceBrand = { businessName: string; replyTo?: string; accent: string; onAccent: string; logoUrl?: string | null };

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** "2026-10-20" → "20 Oct 2026" */
export const formatDay = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** A simple branded email: logo or name on the accent band, paragraphs, one button. */
function brandedHtml(brand: InvoiceBrand, paragraphs: string[], button?: { label: string; href: string }) {
  const name = escapeHtml(brand.businessName);
  const header = brand.logoUrl
    ? `<img src="${escapeHtml(brand.logoUrl)}" alt="${name}" style="max-height:48px;max-width:200px;display:block">`
    : `<div style="font-size:18px;font-weight:600;color:${brand.accent}">${name}</div>`;
  const body = paragraphs.map((p) => `<p style="margin:0 0 16px;font-size:15px;line-height:1.5;color:#1F2937">${p}</p>`).join("");
  const cta = button
    ? `<p style="margin:24px 0"><a href="${escapeHtml(button.href)}" style="background:${brand.accent};color:${brand.onAccent};padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">${escapeHtml(button.label)}</a></p>`
    : "";
  return (
    `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px">` +
    `<div style="border-top:4px solid ${brand.accent};padding-top:20px;margin-bottom:24px">${header}</div>${body}${cta}` +
    `<p style="margin:32px 0 0;font-size:12px;color:#6B7280">Sent by ${name} using ${env.appName}.</p></div>`
  );
}

export const sendInvoiceEmail = (
  to: string,
  opts: { brand: InvoiceBrand; number: string; totalKobo: number; balanceKobo: number; dueDate: string; link: string; message?: string; attachment: EmailAttachment },
) => {
  const { brand } = opts;
  const due = `${formatNaira(opts.balanceKobo)} due by ${formatDay(opts.dueDate)}`;
  return sendEmail({
    to,
    replyTo: brand.replyTo,
    subject: `Invoice ${opts.number} from ${brand.businessName}`,
    text:
      (opts.message ? `${opts.message}\n\n` : "") +
      `${brand.businessName} has sent you invoice ${opts.number} for ${formatNaira(opts.totalKobo)}: ${due}.\n\n` +
      `View and pay: ${opts.link}\n\nThe invoice is attached as a PDF.`,
    html: brandedHtml(
      brand,
      [
        ...(opts.message ? [escapeHtml(opts.message).replace(/\n/g, "<br>")] : []),
        `${escapeHtml(brand.businessName)} has sent you invoice <strong>${escapeHtml(opts.number)}</strong> for ${formatNaira(opts.totalKobo)}.`,
        `<strong>${due}</strong>. The invoice is attached as a PDF.`,
      ],
      { label: "View invoice", href: opts.link },
    ),
    attachments: [opts.attachment],
  });
};

export const sendInvoiceReminderEmail = (
  to: string,
  opts: { brand: InvoiceBrand; number: string; balanceKobo: number; dueDate: string; tone: "upcoming" | "due_today" | "overdue"; link: string; attachment: EmailAttachment },
) => {
  const { brand } = opts;
  const amount = formatNaira(opts.balanceKobo);
  const copy: Record<typeof opts.tone, [subject: string, line: string]> = {
    upcoming: [`Reminder: invoice ${opts.number} is due ${formatDay(opts.dueDate)}`, `${amount} on invoice ${opts.number} is due on ${formatDay(opts.dueDate)}.`],
    due_today: [`Invoice ${opts.number} is due today`, `${amount} on invoice ${opts.number} is due today.`],
    overdue: [`Invoice ${opts.number} is overdue`, `${amount} on invoice ${opts.number} was due on ${formatDay(opts.dueDate)} and is still unpaid.`],
  };
  const [subject, line] = copy[opts.tone];
  return sendEmail({
    to,
    replyTo: brand.replyTo,
    subject: `${subject} (${brand.businessName})`,
    text: `${line}\n\nView and pay: ${opts.link}\n\nIf you've already paid, thank you, and please ignore this reminder.`,
    html: brandedHtml(brand, [escapeHtml(line), "If you've already paid, thank you, and please ignore this reminder."], { label: "View invoice", href: opts.link }),
    attachments: [opts.attachment],
  });
};

export const sendInvoicePaymentReceivedEmail = (
  to: string,
  opts: { brand: InvoiceBrand; number: string; amountKobo: number; balanceKobo: number; link: string },
) => {
  const line = `${opts.brand.businessName} received ${formatNaira(opts.amountKobo)} towards invoice ${opts.number}. ${formatNaira(opts.balanceKobo)} is still due.`;
  return sendEmail({
    to,
    replyTo: opts.brand.replyTo,
    subject: `Payment received for invoice ${opts.number}`,
    text: `${line}\n\nView the invoice: ${opts.link}`,
    html: brandedHtml(opts.brand, [escapeHtml(line)], { label: "View invoice", href: opts.link }),
  });
};

export const sendInvoiceReceiptEmail = (
  to: string,
  opts: { brand: InvoiceBrand; number: string; paidKobo: number; link: string; attachment: EmailAttachment },
) => {
  const line = `Thank you. ${opts.brand.businessName} has received ${formatNaira(opts.paidKobo)}, and invoice ${opts.number} is paid in full.`;
  return sendEmail({
    to,
    replyTo: opts.brand.replyTo,
    subject: `Receipt for invoice ${opts.number} from ${opts.brand.businessName}`,
    text: `${line}\n\nYour receipt is attached. View it online: ${opts.link}`,
    html: brandedHtml(opts.brand, [escapeHtml(line), "Your receipt is attached."], { label: "View receipt", href: opts.link }),
    attachments: [opts.attachment],
  });
};

/** To someone who paid through a payment link, once their transfer is matched. */
export const sendPaymentLinkReceiptEmail = (
  to: string,
  opts: {
    brand: InvoiceBrand;
    title: string;
    payerName: string;
    paidKobo: number;
    reference: string;
    paidAt: Date;
    message?: string | null;
    clientReference?: string | null;
    donation?: boolean;
    /** A simulated payment on a link in test mode: says so, since no money moved. */
    test?: boolean;
  },
) => {
  const when = opts.paidAt.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Lagos" });
  const line = opts.donation
    ? `Thank you, ${opts.payerName}. ${opts.brand.businessName} has received your donation of ${formatNaira(opts.paidKobo)} to ${opts.title}.`
    : `Thank you, ${opts.payerName}. ${opts.brand.businessName} has received ${formatNaira(opts.paidKobo)} for ${opts.title}.`;
  // The business's own order number, when its website sent one.
  const order = opts.clientReference ? ` Your order: ${opts.clientReference}.` : "";
  const details = `Reference: ${opts.reference}.${order} Paid ${when} (Lagos time).`;
  const test = opts.test ? "This was a test payment in test mode. No money was sent." : null;
  const paragraphs = [test, line, opts.message, details].filter((p): p is string => !!p);
  return sendEmail({
    to,
    replyTo: opts.brand.replyTo,
    subject: `${opts.test ? "[Test] " : ""}${opts.donation ? "Donation received" : "Payment received"}: ${opts.title} (${opts.brand.businessName})`,
    text: paragraphs.join("\n\n"),
    html: brandedHtml(opts.brand, paragraphs.map(escapeHtml)),
  });
};

/** To the team member who created the invoice. */
export const sendInvoicePaidNotice = (to: string, opts: { number: string; customerName: string; paidKobo: number; invoiceId: string }) =>
  sendEmail({
    to,
    subject: `Paid: invoice ${opts.number} (${formatNaira(opts.paidKobo)})`,
    text: `${opts.customerName} has paid invoice ${opts.number} in full (${formatNaira(opts.paidKobo)}). We've sent them a receipt.\n\nView it: ${env.webUrl}/invoices/${opts.invoiceId}`,
  });
