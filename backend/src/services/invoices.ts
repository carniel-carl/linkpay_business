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

/**
 * Issues the invoice. With `email`, sends it (link + PDF) to the customer; without, it's just marked as sent
 * so the link can be shared another way (WhatsApp, SMS). Re-sending an issued invoice emails it again.
 */
export async function sendInvoice(business: BusinessDocument, invoice: InvoiceDocument, opts: { email: boolean; to?: string; message?: string }) {
  if (invoice.status === "void") throw new HttpError(409, "A void invoice can't be sent", "INVOICE_VOID");
  if (!invoice.items.length || invoice.totalKobo < 100) throw new HttpError(400, "Add at least one item before sending", "INVOICE_EMPTY");
  if (!(await payToAccount(invoice))) throw new HttpError(409, "This branch's account isn't ready yet", "ACCOUNT_NOT_READY");

  const to = opts.to ?? invoice.customer?.email ?? undefined;
  if (opts.email && !to) throw new HttpError(400, "Add the customer's email address, or share the link instead", "CUSTOMER_EMAIL_REQUIRED");

  if (invoice.status === "draft") invoice.status = "open";
  invoice.issuedAt ??= new Date();
  if (opts.email && to) {
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
    invoice.lastSentAt = new Date();
    invoice.lastSentTo = to;
  }
  await invoice.save();
  return invoice;
}

const REMINDER_COOLDOWN_MS = 60 * 60 * 1000;

/** A reminder now (from the dashboard). Once an hour at most. */
export async function remindNow(business: BusinessDocument, invoice: InvoiceDocument) {
  if (!UNPAID_INVOICE_STATUSES.includes(invoice.status as any)) throw new HttpError(409, "Only unpaid invoices get reminders", "INVOICE_NOT_UNPAID");
  if (!invoice.customer?.email) throw new HttpError(400, "This customer has no email address", "CUSTOMER_EMAIL_REQUIRED");
  const last = invoice.reminders?.lastSentAt?.getTime() ?? 0;
  if (Date.now() - last < REMINDER_COOLDOWN_MS) {
    const retryAt = new Date(last + REMINDER_COOLDOWN_MS);
    throw new HttpError(429, "A reminder was sent recently. Try again later.", "REMINDER_COOLDOWN", { retryAt: retryAt.toISOString() });
  }
  await sendReminder(business, invoice, isOverdue(invoice) ? "overdue" : "upcoming");
  return invoice;
}

async function sendReminder(business: BusinessDocument, invoice: InvoiceDocument, tone: "upcoming" | "due_today" | "overdue") {
  await sendInvoiceReminderEmail(invoice.customer!.email!, {
    brand: brandFor(business, invoice),
    number: invoice.number,
    balanceKobo: balanceDue(invoice),
    dueDate: invoice.dueDate,
    tone,
    link: publicInvoiceUrl(invoice),
    attachment: await pdfAttachment(business, invoice),
  });
  invoice.set("reminders.lastSentAt", new Date());
  await invoice.save();
}

// Automatic reminders, by days relative to the due date. Each is sent at most once per due date.
const SCHEDULE = [
  { kind: "before_due", offset: -3, tone: "upcoming" },
  { kind: "due_today", offset: 0, tone: "due_today" },
  { kind: "overdue_3", offset: 3, tone: "overdue" },
  { kind: "overdue_10", offset: 10, tone: "overdue" },
] as const;

/** Sends the reminders that are due. Runs in the background a few times a day; safe to run more often. */
export async function sendScheduledReminders(today = todayInLagos()) {
  const candidates = await InvoiceModel.find({
    status: { $in: UNPAID_INVOICE_STATUSES },
    "reminders.enabled": true,
    "customer.email": { $exists: true, $ne: null },
    dueDate: { $lte: addDays(today, 3) },
  }).limit(500);
  let sent = 0;
  const businesses = new Map<string, BusinessDocument | null>();
  for (const invoice of candidates) {
    const age = daysBetween(invoice.dueDate, today);
    // The latest step that's reached and not yet sent; earlier missed steps are skipped, not sent in a burst.
    const step = [...SCHEDULE].reverse().find((s) => age >= s.offset);
    if (!step || invoice.reminders?.sent?.includes(step.kind)) continue;
    // Don't remind about an invoice issued in the last day (e.g. issued two days before it's due).
    if (invoice.issuedAt && Date.now() - invoice.issuedAt.getTime() < 24 * 60 * 60 * 1000) continue;
    const key = String(invoice.business);
    if (!businesses.has(key)) businesses.set(key, await BusinessModel.findById(invoice.business));
    const business = businesses.get(key);
    if (!business) continue;
    try {
      invoice.reminders!.sent.push(step.kind);
      await sendReminder(business, invoice, step.tone);
      sent++;
    } catch (err) {
      console.error(`Couldn't send reminder for invoice ${invoice.id}:`, err);
    }
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

/** Records a payment by hand (cash, POS) or links an incoming transfer that the matcher missed. */
export async function addPayment(business: BusinessDocument, invoice: InvoiceDocument, userId: string, input: PaymentInput) {
  if (!UNPAID_INVOICE_STATUSES.includes(invoice.status as any)) {
    throw new HttpError(409, invoice.status === "draft" ? "Send or mark the invoice as sent first" : "This invoice isn't waiting for payment", "INVOICE_NOT_UNPAID");
  }
  if ("transactionId" in input) {
    const tx = await TransactionModel.findOne({ _id: input.transactionId, business: business._id, direction: "credit", status: "success" });
    if (!tx) throw new HttpError(404, "Payment not found", "TRANSACTION_NOT_FOUND");
    // Claim it atomically so the same payment can't count towards two invoices.
    const claimed = await TransactionModel.findOneAndUpdate(
      { _id: tx._id, invoice: { $exists: false } },
      { invoice: invoice._id, invoiceCheckedAt: new Date() },
    );
    if (!claimed) throw new HttpError(409, "That payment is already linked to an invoice", "TRANSACTION_ALREADY_LINKED");
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
  return TransactionModel.find({
    business: invoice.business,
    direction: "credit",
    status: "success",
    invoice: { $exists: false },
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
