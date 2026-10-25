import { randomBytes } from "node:crypto";
import type { Types } from "mongoose";
import { env } from "../config/env";
import { BranchModel } from "../models/Branch";
import { BusinessModel, type BusinessDocument } from "../models/Business";
import { InvoiceCustomerModel } from "../models/InvoiceCustomer";
import { InvoiceModel, UNPAID_INVOICE_STATUSES, type InvoiceDocument, type PAYMENT_METHODS } from "../models/Invoice";
import { TransactionModel } from "../models/Transaction";
import { UserModel } from "../models/User";
import { VirtualAccountModel } from "../models/VirtualAccount";
import { HttpError } from "../utils/HttpError";
import {
  sendInvoiceEmail,
  sendInvoicePaidNotice,
  sendInvoicePaymentReceivedEmail,
  sendInvoiceReceiptEmail,
  sendInvoiceReminderEmail,
  type InvoiceBrand,
} from "./email";
import { accentPalette } from "./branding";
import { renderInvoicePdf } from "./invoicePdf";
import { invoiceOverdue, invoicePaid, invoicePaymentReceived } from "./notificationEvents";

// ---------------------------------------------------------------------------------------------------------
// Dates (calendar days in Lagos) and totals
// ---------------------------------------------------------------------------------------------------------

const lagosDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos", year: "numeric", month: "2-digit", day: "2-digit" });

/** Today in Lagos as "YYYY-MM-DD". */
export const todayInLagos = (now = new Date()) => lagosDay.format(now);

/** "YYYY-MM-DD" plus `days`. */
export function addDays(day: string, days: number) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);

export type ItemInput = { description: string; quantity: number; unitPriceKobo: number };
export type DiscountInput = { type: "amount"; amountKobo: number } | { type: "percent"; percentBps: number } | null;

/** Line amounts, discount, VAT on the discounted subtotal, and the total. All integers in kobo. */
export function computeTotals(items: ItemInput[], discount: DiscountInput, vatRateBps: number | null) {
  const lines = items.map((i) => ({ ...i, amountKobo: Math.round(i.quantity * i.unitPriceKobo) }));
  const subtotalKobo = lines.reduce((s, l) => s + l.amountKobo, 0);
  let discountKobo = 0;
  if (discount?.type === "amount") discountKobo = Math.min(discount.amountKobo, subtotalKobo);
  if (discount?.type === "percent") discountKobo = Math.round((subtotalKobo * discount.percentBps) / 10_000);
  const vatKobo = vatRateBps ? Math.round(((subtotalKobo - discountKobo) * vatRateBps) / 10_000) : 0;
  return {
    items: lines,
    subtotalKobo,
    discount: discount ? { type: discount.type, value: discount.type === "amount" ? discount.amountKobo : discount.percentBps } : undefined,
    discountKobo,
    vatRateBps: vatRateBps ?? undefined,
    vatKobo,
    totalKobo: subtotalKobo - discountKobo + vatKobo,
  };
}

export const balanceDue = (invoice: { totalKobo: number; paidKobo?: number | null }) => Math.max(0, invoice.totalKobo - (invoice.paidKobo ?? 0));

export const isOverdue = (invoice: { status: string; dueDate: string }, today = todayInLagos()) =>
  UNPAID_INVOICE_STATUSES.includes(invoice.status as any) && invoice.dueDate < today;

export const publicInvoiceUrl = (invoice: { publicToken: string }) => `${env.webUrl}/i/${invoice.publicToken}`;

/** How customer emails about this invoice look: the business's name, accent and logo; replies go to the business. */
export function brandFor(business: BusinessDocument, invoice: { publicToken: string }): InvoiceBrand {
  const { accent, onAccent } = accentPalette(business.branding?.accentColor);
  const logo = business.branding?.logo;
  return {
    businessName: business.name,
    replyTo: business.email ?? undefined,
    accent,
    onAccent,
    // The web serves the logo next to the public invoice (GET /api/public/invoices/:token/logo behind it).
    logoUrl: logo?.key ? `${publicInvoiceUrl(invoice)}/logo?v=${logo.updatedAt?.getTime() ?? 0}` : null,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Creating and editing
// ---------------------------------------------------------------------------------------------------------

export type CustomerInput = { id: string } | { name: string; email?: string; phone?: string; address?: string; save?: boolean };

export type InvoiceInput = {
  branch?: string;
  customer?: CustomerInput;
  issueDate?: string;
  dueDate?: string;
  items?: ItemInput[];
  discount?: DiscountInput;
  vatRateBps?: number | null;
  notes?: string | null;
  terms?: string | null;
  footer?: string | null;
  remindersEnabled?: boolean;
};

async function resolveCustomer(business: BusinessDocument, input: CustomerInput) {
  if ("id" in input) {
    const saved = await InvoiceCustomerModel.findOne({ _id: input.id, business: business._id });
    if (!saved) throw new HttpError(404, "Customer not found", "CUSTOMER_NOT_FOUND");
    return { ref: saved._id, name: saved.name, email: saved.email, phone: saved.phone, address: saved.address };
  }
  let ref: Types.ObjectId | undefined;
  if (input.save) {
    // Reuse a saved customer with the same email rather than adding a duplicate.
    const existing = input.email ? await InvoiceCustomerModel.findOne({ business: business._id, email: input.email.toLowerCase(), archived: false }) : null;
    const saved =
      existing ??
      (await InvoiceCustomerModel.create({ business: business._id, name: input.name, email: input.email, phone: input.phone, address: input.address }));
    ref = saved._id;
  }
  return { ref, name: input.name, email: input.email, phone: input.phone, address: input.address };
}

async function nextNumber(business: BusinessDocument) {
  const updated = await BusinessModel.findOneAndUpdate({ _id: business._id }, { $inc: { invoiceSeq: 1 } }, { returnDocument: "after" });
  const seq = updated!.invoiceSeq;
  const prefix = business.branding?.invoice?.prefix || "INV";
  return { seq, number: `${prefix}-${String(seq).padStart(4, "0")}` };
}

async function assertBranch(business: BusinessDocument, branchId: string) {
  const branch = await BranchModel.findOne({ _id: branchId, business: business._id });
  if (!branch) throw new HttpError(404, "Branch not found", "INVALID_BRANCH");
  return branch;
}

/** A new draft. Missing dates, VAT, notes and terms come from the business's invoice settings. */
export async function createInvoice(business: BusinessDocument, userId: string, input: InvoiceInput & { branch: string; customer: CustomerInput; items: ItemInput[] }) {
  const branch = await assertBranch(business, input.branch);
  const settings = business.branding?.invoice;
  const issueDate = input.issueDate ?? todayInLagos();
  const dueDate = input.dueDate ?? addDays(issueDate, settings?.defaultDueDays ?? 14);
  if (dueDate < issueDate) throw new HttpError(400, "The due date can't be before the issue date", "INVALID_DATES");
  const vatRateBps = input.vatRateBps !== undefined ? input.vatRateBps : settings?.vatByDefault ? (settings.vatRateBps ?? 750) : null;
  const customer = await resolveCustomer(business, input.customer);
  const totals = computeTotals(input.items, input.discount ?? null, vatRateBps);
  const { seq, number } = await nextNumber(business);

  return InvoiceModel.create({
    business: business._id,
    branch: branch._id,
    number,
    seq,
    customer,
    issueDate,
    dueDate,
    ...totals,
    notes: input.notes !== undefined ? (input.notes ?? undefined) : (settings?.notes ?? undefined),
    terms: input.terms !== undefined ? (input.terms ?? undefined) : (settings?.terms ?? undefined),
    footer: input.footer !== undefined ? (input.footer ?? undefined) : (settings?.footer ?? undefined),
    status: "draft",
    publicToken: randomBytes(24).toString("base64url"),
    reminders: { enabled: input.remindersEnabled ?? true, sent: [] },
    createdBy: userId,
  });
}

/** Drafts and issued invoices without payments can be edited; after a payment only notes, terms and dates can. */
export async function updateInvoice(business: BusinessDocument, invoice: InvoiceDocument, input: InvoiceInput) {
  if (invoice.status === "void") throw new HttpError(409, "A void invoice can't be changed", "INVOICE_VOID");
  const locked = invoice.payments.length > 0;
  const touchesMoney = input.items !== undefined || input.discount !== undefined || input.vatRateBps !== undefined || input.branch !== undefined || input.customer !== undefined;
  if (locked && touchesMoney) {
    throw new HttpError(409, "This invoice has payments, so its items, amounts, customer and account can't change", "INVOICE_HAS_PAYMENTS");
  }

  if (input.branch) invoice.branch = (await assertBranch(business, input.branch))._id;
  if (input.customer) invoice.set("customer", await resolveCustomer(business, input.customer));
  if (input.issueDate) invoice.issueDate = input.issueDate;
  if (input.dueDate) invoice.dueDate = input.dueDate;
  if (invoice.dueDate < invoice.issueDate) throw new HttpError(400, "The due date can't be before the issue date", "INVALID_DATES");
  if (input.dueDate) {
    invoice.set("reminders.sent", []); // a new due date restarts the reminder schedule
    invoice.set("overdueNotifiedAt", undefined);
  }

  if (!locked && (input.items || input.discount !== undefined || input.vatRateBps !== undefined)) {
    const current = {
      items: invoice.items.map((i) => ({ description: i.description, quantity: i.quantity, unitPriceKobo: i.unitPriceKobo })),
      discount: invoice.discount?.type
        ? invoice.discount.type === "amount"
          ? ({ type: "amount", amountKobo: invoice.discount.value! } as const)
          : ({ type: "percent", percentBps: invoice.discount.value! } as const)
        : null,
      vat: invoice.vatRateBps ?? null,
    };
    invoice.set(
      computeTotals(
        input.items ?? current.items,
        input.discount !== undefined ? input.discount : current.discount,
        input.vatRateBps !== undefined ? input.vatRateBps : current.vat,
      ),
    );
  }
  for (const field of ["notes", "terms", "footer"] as const) {
    if (input[field] !== undefined) invoice.set(field, input[field] ?? undefined);
  }
  if (input.remindersEnabled !== undefined) invoice.set("reminders.enabled", input.remindersEnabled);
  await invoice.save();
  return invoice;
}

export async function duplicateInvoice(business: BusinessDocument, userId: string, source: InvoiceDocument) {
  const days = daysBetween(source.issueDate, source.dueDate);
  const issueDate = todayInLagos();
  return createInvoice(business, userId, {
    branch: String(source.branch),
    customer: source.customer!.ref
      ? { id: String(source.customer!.ref) }
      : { name: source.customer!.name, email: source.customer!.email ?? undefined, phone: source.customer!.phone ?? undefined, address: source.customer!.address ?? undefined },
    issueDate,
    dueDate: addDays(issueDate, Math.max(days, 0)),
    items: source.items.map((i) => ({ description: i.description, quantity: i.quantity, unitPriceKobo: i.unitPriceKobo })),
    discount: source.discount?.type
      ? source.discount.type === "amount"
        ? { type: "amount", amountKobo: source.discount.value! }
        : { type: "percent", percentBps: source.discount.value! }
      : null,
    vatRateBps: source.vatRateBps ?? null,
    notes: source.notes ?? null,
    terms: source.terms ?? null,
    footer: source.footer ?? null,
  });
}

// ---------------------------------------------------------------------------------------------------------
// Issuing, reminders, voiding
// ---------------------------------------------------------------------------------------------------------

/** What the customer pays into: the invoice branch's account. */
export async function payToAccount(invoice: { branch: Types.ObjectId }) {
  const account = await VirtualAccountModel.findOne({ branch: invoice.branch }).select("accountNumber accountName bankName");
  return account ? { accountNumber: account.accountNumber, accountName: account.accountName ?? null, bankName: account.bankName ?? null } : null;
}

async function pdfAttachment(business: BusinessDocument, invoice: InvoiceDocument, kind: "invoice" | "receipt" = "invoice") {
  const pdf = await renderInvoicePdf(business, invoice, { kind, account: await payToAccount(invoice) });
  return { filename: `${kind === "receipt" ? "Receipt" : "Invoice"} ${invoice.number}.pdf`, content: pdf, contentType: "application/pdf" };
}

// Emails the team sends a customer (a send, or "remind now") are limited, since anyone can be put down as the
// customer: without limits an account could mail strangers through us. Per invoice, one a minute and 5 in any
// 24 hours; per business, 200 in any 24 hours. Automatic reminders aren't counted: they go once per step.
const EMAIL_COOLDOWN_MS = 60 * 1000;
export const MAX_EMAILS_PER_INVOICE = 5;
export const MAX_EMAILS_PER_BUSINESS = 200;
const EMAIL_WINDOW_MS = 24 * 60 * 60 * 1000;
const REMINDER_COOLDOWN_MS = 60 * 60 * 1000;

const reminderCooldown = (last: number) =>
  new HttpError(429, "A reminder was sent recently. Try again later.", "REMINDER_COOLDOWN", {
    retryAt: new Date(last + REMINDER_COOLDOWN_MS).toISOString(),
  });

/** Why claimCustomerEmail couldn't claim, read back from the invoice. */
async function emailRefusal(invoiceId: Types.ObjectId, kind: "send" | "reminder") {
  const current = await InvoiceModel.findById(invoiceId).select("emailLog reminders");
  if (!current) return new HttpError(404, "Invoice not found", "INVOICE_NOT_FOUND");
  const now = Date.now();
  const lastReminder = current.reminders?.lastSentAt?.getTime() ?? 0;
  if (kind === "reminder" && now - lastReminder < REMINDER_COOLDOWN_MS) return reminderCooldown(lastReminder);
  const log = current.emailLog ?? [];
  const last = log.at(-1)?.getTime() ?? 0;
  if (now - last < EMAIL_COOLDOWN_MS) {
    return new HttpError(429, "This invoice was emailed a moment ago. Try again in a minute.", "INVOICE_EMAIL_COOLDOWN", {
      retryAt: new Date(last + EMAIL_COOLDOWN_MS).toISOString(),
    });
  }
  const oldest = log[0]?.getTime() ?? 0;
  if (log.length >= MAX_EMAILS_PER_INVOICE && now - oldest < EMAIL_WINDOW_MS) {
    return new HttpError(
      429,
      `This invoice has been emailed ${MAX_EMAILS_PER_INVOICE} times in the last 24 hours. Share the link instead, or try again later.`,
      "INVOICE_EMAIL_LIMIT",
      { retryAt: new Date(oldest + EMAIL_WINDOW_MS).toISOString() },
    );
  }
  // Whatever was in the way cleared between the claim and this read.
  return new HttpError(409, "This invoice changed while sending. Try again.", "INVOICE_CHANGED");
}

/**
 * Takes one email from the invoice's and the business's allowance before it goes out. The invoice's is a
 * conditional update, so parallel requests can't both pass the cooldown or the cap. The business's is counted
 * after claiming, so parallel requests each see the others (at worst both are refused, never both let past).
 * A reminder also claims the hour-long "remind now" cooldown. Returns `release`, which gives it all back if
 * the email then fails.
 */
async function claimCustomerEmail(invoice: InvoiceDocument, kind: "send" | "reminder") {
  const now = Date.now();
  const at = new Date(now);
  const since = new Date(now - EMAIL_WINDOW_MS);
  const reminder = kind === "reminder";
  const previousReminder = invoice.reminders?.lastSentAt ?? null;
  const claimed = await InvoiceModel.updateOne(
    {
      _id: invoice._id,
      emailLog: { $not: { $gt: new Date(now - EMAIL_COOLDOWN_MS) } },
      // Fewer than the cap in the window: the log keeps only the newest MAX entries, oldest first.
      $or: [{ [`emailLog.${MAX_EMAILS_PER_INVOICE - 1}`]: { $exists: false } }, { "emailLog.0": { $lte: since } }],
      ...(reminder && { "reminders.lastSentAt": { $not: { $gt: new Date(now - REMINDER_COOLDOWN_MS) } } }),
    },
    {
      $push: { emailLog: { $each: [at], $slice: -MAX_EMAILS_PER_INVOICE } },
      ...(reminder && { $set: { "reminders.lastSentAt": at } }),
    },
  );
  if (!claimed.modifiedCount) throw await emailRefusal(invoice._id, kind);

  const release = async () => {
    await InvoiceModel.updateOne({ _id: invoice._id }, { $pull: { emailLog: at } });
    if (reminder) {
      await InvoiceModel.updateOne(
        { _id: invoice._id, "reminders.lastSentAt": at },
        previousReminder ? { $set: { "reminders.lastSentAt": previousReminder } } : { $unset: { "reminders.lastSentAt": 1 } },
      );
    }
  };

  const [usage] = await InvoiceModel.aggregate<{ count: number; oldest: Date }>([
    { $match: { business: invoice.business, emailLog: { $gt: since } } },
    { $project: { recent: { $filter: { input: "$emailLog", cond: { $gt: ["$$this", since] } } } } },
    { $unwind: "$recent" },
    { $group: { _id: null, count: { $sum: 1 }, oldest: { $min: "$recent" } } },
  ]);
  if ((usage?.count ?? 0) > MAX_EMAILS_PER_BUSINESS) {
    await release();
    throw new HttpError(
      429,
      `Your business has emailed ${MAX_EMAILS_PER_BUSINESS} invoices and reminders in the last 24 hours, the most we allow. Share the link instead, or try again later.`,
      "BUSINESS_EMAIL_LIMIT",
      { retryAt: new Date(usage!.oldest.getTime() + EMAIL_WINDOW_MS).toISOString() },
    );
  }
  return { at, release };
}

/**
 * Issues the invoice. With `email`, sends it (link + PDF) to the customer; without, it's just marked as sent
 * so the link can be shared another way (WhatsApp, SMS). Re-sending an issued invoice emails it again, within
 * the limits above. `to` can be any address (a customer's accounts team, say): the customer's own email is
 * whatever the team typed, so tying `to` to it wouldn't stop anything the limits don't.
 */
export async function sendInvoice(business: BusinessDocument, invoice: InvoiceDocument, opts: { email: boolean; to?: string; message?: string }) {
  if (invoice.status === "void") throw new HttpError(409, "A void invoice can't be sent", "INVOICE_VOID");
  if (!invoice.items.length || invoice.totalKobo < 100) throw new HttpError(400, "Add at least one item before sending", "INVOICE_EMPTY");
  if (!(await payToAccount(invoice))) throw new HttpError(409, "This branch's account isn't ready yet", "ACCOUNT_NOT_READY");

  const to = opts.to ?? invoice.customer?.email ?? undefined;
  if (opts.email && !to) throw new HttpError(400, "Add the customer's email address, or share the link instead", "CUSTOMER_EMAIL_REQUIRED");

  // Before the email: the attached PDF shows the status.
  if (invoice.status === "draft") invoice.status = "open";
  invoice.issuedAt ??= new Date();
  if (opts.email && to) {
    const { at, release } = await claimCustomerEmail(invoice, "send");
    try {
      await sendInvoiceEmail(to, {
        brand: brandFor(business, invoice),
        number: invoice.number,
        totalKobo: invoice.totalKobo,
        balanceKobo: balanceDue(invoice),
        dueDate: invoice.dueDate,
        link: publicInvoiceUrl(invoice),
        message: opts.message,
        attachment: await pdfAttachment(business, invoice),
      });
    } catch (err) {
      await release();
      throw err;
    }
    invoice.lastSentAt = at;
    invoice.lastSentTo = to;
  }
  await invoice.save();
  return invoice;
}

/** A reminder now (from the dashboard). Once an hour at most, and it counts towards the email limits. */
export async function remindNow(business: BusinessDocument, invoice: InvoiceDocument) {
  if (!UNPAID_INVOICE_STATUSES.includes(invoice.status as any)) throw new HttpError(409, "Only unpaid invoices get reminders", "INVOICE_NOT_UNPAID");
  if (!invoice.customer?.email) throw new HttpError(400, "This customer has no email address", "CUSTOMER_EMAIL_REQUIRED");
  const last = invoice.reminders?.lastSentAt?.getTime() ?? 0;
  if (Date.now() - last < REMINDER_COOLDOWN_MS) throw reminderCooldown(last);
  const { at, release } = await claimCustomerEmail(invoice, "reminder");
  try {
    await emailReminder(business, invoice, isOverdue(invoice) ? "overdue" : "upcoming");
  } catch (err) {
    await release();
    throw err;
  }
  invoice.set("reminders.lastSentAt", at);
  return invoice;
}

async function emailReminder(business: BusinessDocument, invoice: InvoiceDocument, tone: "upcoming" | "due_today" | "overdue") {
  await sendInvoiceReminderEmail(invoice.customer!.email!, {
    brand: brandFor(business, invoice),
    number: invoice.number,
    balanceKobo: balanceDue(invoice),
    dueDate: invoice.dueDate,
    tone,
    link: publicInvoiceUrl(invoice),
    attachment: await pdfAttachment(business, invoice),
  });
}

// Automatic reminders, by days relative to the due date. Each is sent at most once per due date.
const SCHEDULE = [
  { kind: "before_due", offset: -3, tone: "upcoming" },
  { kind: "due_today", offset: 0, tone: "due_today" },
  { kind: "overdue_3", offset: 3, tone: "overdue" },
  { kind: "overdue_10", offset: 10, tone: "overdue" },
] as const;

/** An invoice more than this many days overdue gets no more automatic reminders (overdue_10 is the last step). */
const REMINDER_WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The invoices with a step to send today: for each step, the due dates for which it's the latest step reached
 * (before_due 1 to 3 days ahead, due_today on the day and the 2 after, overdue_3 from day 3 to 9, overdue_10 from
 * day 10 to REMINDER_WINDOW_DAYS), and only where that step hasn't gone yet. Invoices between steps or done with
 * the schedule never match, so the batch limit can't fill up with them and starve the rest. Each branch is a
 * range on the { status, dueDate } index.
 */
function dueStepFilter(today: string) {
  return SCHEDULE.map((step, i) => {
    const next = SCHEDULE[i + 1];
    const oldest = next ? addDays(today, 1 - next.offset) : addDays(today, -REMINDER_WINDOW_DAYS);
    return { dueDate: { $gte: oldest, $lte: addDays(today, -step.offset) }, "reminders.sent": { $ne: step.kind } };
  });
}

/** Sends the reminders that are due. Runs in the background a few times a day; safe to run more often, or twice at once. */
export async function sendScheduledReminders(today = todayInLagos()) {
  // Suspended and closed businesses send no reminders (checked again below), so their invoices don't take up the batch.
  const restricted = await BusinessModel.distinct("_id", { "compliance.status": { $nin: [null, "active"] } });
  const due: Record<string, unknown> = {
    status: { $in: UNPAID_INVOICE_STATUSES },
    "reminders.enabled": true,
    "customer.email": { $exists: true, $ne: null },
    // Not issued in the last day (checked again below).
    issuedAt: { $not: { $gt: new Date(Date.now() - DAY_MS) } },
    ...(restricted.length ? { business: { $nin: restricted } } : {}),
    $or: dueStepFilter(today),
  };
  const candidates = await InvoiceModel.find(due).limit(500);
  let sent = 0;
  const businesses = new Map<string, BusinessDocument | null>();
  for (const invoice of candidates) {
    const age = daysBetween(invoice.dueDate, today);
    // The latest step that's reached and not yet sent; earlier missed steps are skipped, not sent in a burst.
    const step = [...SCHEDULE].reverse().find((s) => age >= s.offset);
    if (!step || invoice.reminders?.sent?.includes(step.kind)) continue;
    // Don't remind about an invoice issued in the last day (e.g. issued two days before it's due).
    if (invoice.issuedAt && Date.now() - invoice.issuedAt.getTime() < DAY_MS) continue;
    const key = String(invoice.business);
    if (!businesses.has(key)) businesses.set(key, await BusinessModel.findById(invoice.business));
    const business = businesses.get(key);
    // No reminders from a suspended or closed business (its invoice links are down too).
    if (!business || (business.compliance?.status ?? "active") !== "active") continue;

    // Claim the step before sending, so two runs (two instances, or a slow tick overlapping the next) can't
    // both send it. Only while the invoice is as we read it: still unpaid, same due date, reminders on.
    const claimed = await InvoiceModel.updateOne(
      {
        _id: invoice._id,
        status: { $in: UNPAID_INVOICE_STATUSES },
        dueDate: invoice.dueDate,
        "reminders.enabled": true,
        "reminders.sent": { $ne: step.kind },
      },
      { $addToSet: { "reminders.sent": step.kind } },
    );
    if (!claimed.modifiedCount) continue;
    try {
      await emailReminder(business, invoice, step.tone);
    } catch (err) {
      console.error(`Couldn't send reminder for invoice ${invoice.id}:`, err);
      // Give the step back so the next run tries again.
      await InvoiceModel.updateOne({ _id: invoice._id }, { $pull: { "reminders.sent": step.kind } }).catch((e) =>
        console.error(`Couldn't release reminder ${step.kind} for invoice ${invoice.id}:`, e),
      );
      continue;
    }
    sent++;
    await InvoiceModel.updateOne({ _id: invoice._id }, { $set: { "reminders.lastSentAt": new Date() } }).catch((err) =>
      console.error(`Couldn't record the reminder time for invoice ${invoice.id}:`, err),
    );
  }
  return { sent };
}

const lagosHour = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Lagos", hour: "numeric", hourCycle: "h23" });

/** Checks for due reminders every `intervalMs`, sending only between 08:00 and 20:00 in Lagos. */
export function startInvoiceReminders(intervalMs: number) {
  if (intervalMs <= 0) return () => {};
  const tick = () => {
    const hour = Number(lagosHour.format(new Date()));
    if (hour < 8 || hour >= 20) return;
    sendScheduledReminders().catch((err) => console.error("Invoice reminders failed:", err));
    notifyOverdueInvoices().catch((err) => console.error("Overdue invoice notifications failed:", err));
  };
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
}

/**
 * Tells the team once when an invoice passes its due date unpaid (whether or not the customer gets
 * reminders). Only invoices due in the last 30 days, so old ones don't all arrive at once.
 */
export async function notifyOverdueInvoices(today = todayInLagos()) {
  const overdue = await InvoiceModel.find({
    status: { $in: UNPAID_INVOICE_STATUSES },
    dueDate: { $lt: today, $gte: addDays(today, -30) },
    overdueNotifiedAt: null,
  }).limit(500);
  let notified = 0;
  for (const invoice of overdue) {
    // Claim it first, so two runs can't both notify.
    const claimed = await InvoiceModel.updateOne({ _id: invoice._id, overdueNotifiedAt: null }, { overdueNotifiedAt: new Date() });
    if (!claimed.modifiedCount) continue;
    const business = await BusinessModel.findById(invoice.business).select("name owner");
    if (!business) continue;
    await invoiceOverdue(business, invoice, balanceDue(invoice));
    notified++;
  }
  return { notified };
}

export async function voidInvoice(invoice: InvoiceDocument) {
  if (invoice.status === "void") return invoice;
  if (invoice.status === "draft") throw new HttpError(409, "Delete a draft instead of voiding it", "INVOICE_IS_DRAFT");
  if (invoice.payments.length) throw new HttpError(409, "Remove the payments on this invoice before voiding it", "INVOICE_HAS_PAYMENTS");
  invoice.status = "void";
  invoice.voidedAt = new Date();
  await invoice.save();
  return invoice;
}

// ---------------------------------------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------------------------------------

/** Sets paidKobo and the status from the payments, and sends the receipt or a part-payment note. */
async function settle(invoice: InvoiceDocument, opts: { notify: boolean }) {
  const wasPaid = invoice.status === "paid";
  const before = invoice.paidKobo ?? 0;
  const paidKobo = invoice.payments.reduce((s, p) => s + p.amountKobo, 0);
  invoice.paidKobo = paidKobo;
  if (paidKobo >= invoice.totalKobo && paidKobo > 0) {
    invoice.status = "paid";
    invoice.paidAt ??= new Date(Math.max(...invoice.payments.map((p) => p.paidAt.getTime())));
  } else {
    invoice.status = paidKobo > 0 ? "partially_paid" : "open";
    invoice.set({ paidAt: undefined });
  }
  await invoice.save();

  if (!opts.notify || paidKobo <= before) return invoice;
  const business = await BusinessModel.findById(invoice.business);
  if (!business) return invoice;
  try {
    if (invoice.status === "paid" && !wasPaid) {
      if (invoice.customer?.email && !invoice.receiptSentAt) {
        await sendInvoiceReceiptEmail(invoice.customer.email, {
          brand: brandFor(business, invoice),
          number: invoice.number,
          paidKobo,
          link: publicInvoiceUrl(invoice),
          attachment: await pdfAttachment(business, invoice, "receipt"),
        });
        invoice.receiptSentAt = new Date();
        await invoice.save();
      }
      const creator = await UserModel.findById(invoice.createdBy).select("email");
      if (creator) await sendInvoicePaidNotice(creator.email, { number: invoice.number, customerName: invoice.customer!.name, paidKobo, invoiceId: invoice.id });
    } else if (invoice.status === "partially_paid" && invoice.customer?.email) {
      await sendInvoicePaymentReceivedEmail(invoice.customer.email, {
        brand: brandFor(business, invoice),
        number: invoice.number,
        amountKobo: paidKobo - before,
        balanceKobo: balanceDue(invoice),
        link: publicInvoiceUrl(invoice),
      });
    }
  } catch (err) {
    console.error(`Couldn't send payment emails for invoice ${invoice.id}:`, err);
  }
  if (invoice.status === "paid" && !wasPaid) await invoicePaid(business, invoice);
  else if (invoice.status === "partially_paid") await invoicePaymentReceived(business, invoice, paidKobo - before, balanceDue(invoice));
  return invoice;
}

export type PaymentInput =
  | { transactionId: string }
  | { amountKobo: number; method: (typeof PAYMENT_METHODS)[number]; paidAt?: Date; note?: string };

/**
 * Records a payment by hand (cash, POS) or links an incoming transfer that the matcher missed. A linked
 * transfer must have come into the invoice's branch's account: one into another branch's is "not found", so a
 * member limited to some branches can't move, or learn about, another branch's money.
 */
export async function addPayment(business: BusinessDocument, invoice: InvoiceDocument, userId: string, input: PaymentInput) {
  if (!UNPAID_INVOICE_STATUSES.includes(invoice.status as any)) {
    throw new HttpError(409, invoice.status === "draft" ? "Send or mark the invoice as sent first" : "This invoice isn't waiting for payment", "INVOICE_NOT_UNPAID");
  }
  if ("transactionId" in input) {
    const accounts = await VirtualAccountModel.find({ business: business._id, branch: invoice.branch }).select("_id");
    const tx = await TransactionModel.findOne({
      _id: input.transactionId,
      business: business._id,
      $or: [{ branch: invoice.branch }, { virtualAccount: { $in: accounts.map((a) => a._id) } }],
      direction: "credit",
      status: "success",
    });
    if (!tx) throw new HttpError(404, "Payment not found", "TRANSACTION_NOT_FOUND");
    // Claim it atomically so the same payment can't count towards two invoices.
    const claimed = await TransactionModel.findOneAndUpdate(
      { _id: tx._id, invoice: { $exists: false }, checkout: { $exists: false } },
      { invoice: invoice._id, invoiceCheckedAt: new Date() },
    );
    if (!claimed) throw new HttpError(409, "That payment is already linked to an invoice or a payment link", "TRANSACTION_ALREADY_LINKED");
    invoice.payments.push({ amountKobo: tx.amountKobo, method: "transfer", transaction: tx._id, auto: false, paidAt: tx.occurredAt, recordedBy: userId as any });
  } else {
    invoice.payments.push({ amountKobo: input.amountKobo, method: input.method, paidAt: input.paidAt ?? new Date(), note: input.note, recordedBy: userId as any });
  }
  return settle(invoice, { notify: true });
}

export async function removePayment(invoice: InvoiceDocument, paymentId: string) {
  const payment = invoice.payments.id(paymentId);
  if (!payment) throw new HttpError(404, "Payment not found");
  if (payment.transaction) {
    // Unlinked, but still marked as checked so the matcher doesn't link it straight back.
    await TransactionModel.updateOne({ _id: payment.transaction }, { $unset: { invoice: 1 }, invoiceCheckedAt: new Date() });
  }
  payment.deleteOne();
  return settle(invoice, { notify: false });
}

/** Incoming payments that look like they're for this invoice: the exact balance, or the customer's name. */
export async function suggestPayments(invoice: InvoiceDocument) {
  const balance = balanceDue(invoice);
  const words = invoice.customer!.name.split(/\s+/).filter((w) => w.length >= 3).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  // Only payments into the invoice's own branch, the same ones addPayment would accept: a member limited to
  // one branch mustn't see another branch's incoming payments here.
  const accounts = await VirtualAccountModel.find({ business: invoice.business, branch: invoice.branch }).select("_id");
  return TransactionModel.find({
    business: invoice.business,
    $and: [{ $or: [{ branch: invoice.branch }, { virtualAccount: { $in: accounts.map((a) => a._id) } }] }],
    direction: "credit",
    status: "success",
    invoice: { $exists: false },
    checkout: { $exists: false },
    occurredAt: { $gte: new Date(Date.parse(`${invoice.issueDate}T00:00:00+01:00`) - 7 * 86_400_000) },
    $or: [{ amountKobo: balance }, ...(words.length ? [{ "counterparty.name": new RegExp(words.join("|"), "i") }] : [])],
  })
    .sort({ occurredAt: -1 })
    .limit(10);
}

// ---------------------------------------------------------------------------------------------------------
// Matching incoming transfers by narration
// ---------------------------------------------------------------------------------------------------------

/** Letters and digits only, upper case: "inv - 0042" and "INV0042" both become "INV0042". */
const squash = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** The open invoice whose number appears in the narration or reference, if exactly one does. */
export function findInvoiceInText<T extends { seq: number; prefix: string }>(text: string, invoices: T[]): T | null {
  const haystack = squash(text);
  const hits = invoices.filter((inv) => new RegExp(`${squash(inv.prefix)}0*${inv.seq}(?![0-9])`).test(haystack));
  return hits.length === 1 ? hits[0]! : null;
}

/**
 * Links new successful incoming transfers to invoices whose number they mention (e.g. narration
 * "Payment for INV-0042"). Each transfer is looked at once; ambiguous or unmatched ones are left for the
 * business to link by hand. Runs after every inbound sync.
 */
export async function matchInvoicePayments() {
  const pending = await TransactionModel.find({ direction: "credit", status: "success", invoiceCheckedAt: { $exists: false } }).limit(1000);
  // (Transfers that paid a payment-link checkout are marked as checked when they're matched.)
  let matched = 0;
  for (const tx of pending) {
    try {
      const text = [tx.narration, tx.reference].filter(Boolean).join(" ");
      // Only invoices that existed when the money arrived (an hour's slack for bank clocks).
      const candidates = text
        ? await InvoiceModel.find({
            business: tx.business,
            status: { $in: UNPAID_INVOICE_STATUSES },
            createdAt: { $lte: new Date(tx.occurredAt.getTime() + 60 * 60 * 1000) },
          }).select("number seq")
        : [];
      const hit = findInvoiceInText(
        text,
        candidates.map((c) => ({ id: c._id, seq: c.seq, prefix: c.number.replace(/-?\d+$/, "") })),
      );
      const claimed = await TransactionModel.findOneAndUpdate(
        { _id: tx._id, invoiceCheckedAt: { $exists: false } },
        { invoiceCheckedAt: new Date(), ...(hit && { invoice: hit.id }) },
      );
      if (!claimed || !hit) continue;
      const invoice = await InvoiceModel.findById(hit.id);
      if (!invoice || !UNPAID_INVOICE_STATUSES.includes(invoice.status as any)) {
        await TransactionModel.updateOne({ _id: tx._id }, { $unset: { invoice: 1 } });
        continue;
      }
      invoice.payments.push({ amountKobo: tx.amountKobo, method: "transfer", transaction: tx._id, auto: true, paidAt: tx.occurredAt });
      await settle(invoice, { notify: true });
      matched++;
    } catch (err) {
      console.error(`Couldn't match payment ${tx.id} to an invoice:`, err);
    }
  }
  return { checked: pending.length, matched };
}
