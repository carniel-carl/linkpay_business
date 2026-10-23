import type { Request, RequestHandler, Response } from "express";
import { isValidObjectId, Types } from "mongoose";
import { z } from "zod";
import { BranchModel } from "../models/Branch";
import { InvoiceCustomerModel } from "../models/InvoiceCustomer";
import { INVOICE_STATUSES, InvoiceModel, PAYMENT_METHODS, UNPAID_INVOICE_STATUSES, type InvoiceDocument } from "../models/Invoice";
import { UserModel } from "../models/User";
import { renderInvoicePdf } from "../services/invoicePdf";
import {
  addDays,
  addPayment,
  balanceDue,
  createInvoice,
  duplicateInvoice,
  isOverdue,
  payToAccount,
  publicInvoiceUrl,
  remindNow,
  removePayment,
  sendInvoice,
  suggestPayments,
  todayInLagos,
  updateInvoice,
  voidInvoice,
} from "../services/invoices";
import { branchScope, canAccessBranch } from "../services/team";
import { HttpError } from "../utils/HttpError";

type IdParams = { id: string };
type PaymentParams = IdParams & { paymentId: string };

const objectId = z.string().refine(isValidObjectId, "Invalid id");
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .refine((d) => !Number.isNaN(Date.parse(`${d}T12:00:00Z`)) && new Date(`${d}T12:00:00Z`).toISOString().startsWith(d), "Not a real date");
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
const email = z.email().trim().toLowerCase();
const phone = z.string().trim().max(30);

const item = z.object({
  description: z.string().trim().min(1, "Describe the item").max(300),
  // Up to two decimal places (e.g. 2.5 hours).
  quantity: z.number().positive().max(1_000_000).refine((q) => Math.round(q * 100) === q * 100, "Up to 2 decimal places"),
  unitPriceKobo: z.number().int().min(0).max(1_000_000_000_00),
});
const discount = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("amount"), amountKobo: z.number().int().min(1) }),
    z.object({ type: z.literal("percent"), percentBps: z.number().int().min(1).max(10_000) }),
  ])
  .nullable();
const customerFields = {
  name: z.string().trim().min(1, "Enter the customer's name").max(150),
  email: email.optional(),
  phone: phone.optional(),
  address: z.string().trim().max(500).optional(),
};
const customer = z.union([z.object({ id: objectId }), z.object({ ...customerFields, save: z.boolean().optional() })]);

const invoiceFields = {
  branch: objectId,
  customer,
  issueDate: day.optional(),
  dueDate: day.optional(),
  items: z.array(item).max(100),
  discount: discount.optional(),
  vatRateBps: z.number().int().min(0).max(10_000).nullable().optional(),
  notes: optionalText(2000),
  terms: optionalText(2000),
  footer: optionalText(300),
  remindersEnabled: z.boolean().optional(),
};

// ---------------------------------------------------------------------------------------------------------

/** The invoice, if it's this business's and in one of the member's branches. */
async function findInvoice(req: Request, id: string) {
  if (!isValidObjectId(id)) throw new HttpError(400, "Invalid id");
  const invoice = await InvoiceModel.findOne({ _id: id, business: req.business!._id });
  if (!invoice || !canAccessBranch(req.membership!, invoice.branch)) throw new HttpError(404, "Invoice not found", "INVOICE_NOT_FOUND");
  return invoice;
}

function assertBranchAccess(req: Request, branchId?: string) {
  if (branchId && !canAccessBranch(req.membership!, branchId)) throw new HttpError(404, "Branch not found", "INVALID_BRANCH");
}

async function serialize(invoices: InvoiceDocument[], { detail = false } = {}) {
  const today = todayInLagos();
  const [branches, users] = await Promise.all([
    BranchModel.find({ _id: { $in: invoices.map((i) => i.branch) } }).select("name isHeadOffice"),
    UserModel.find({ _id: { $in: invoices.flatMap((i) => [i.createdBy, ...i.payments.map((p) => p.recordedBy)]).filter(Boolean) } }).select("name"),
  ]);
  const branch = (id: Types.ObjectId) => {
    const b = branches.find((x) => x._id.equals(id));
    return b ? { _id: b.id as string, name: b.name, isHeadOffice: b.isHeadOffice } : null;
  };
  const user = (id?: Types.ObjectId | null) => {
    const u = id && users.find((x) => x._id.equals(id));
    return u ? { _id: u.id as string, name: u.name } : null;
  };

  return Promise.all(
    invoices.map(async (inv) => {
      const overdue = isOverdue(inv, today);
      const base = {
        _id: inv.id as string,
        number: inv.number,
        status: inv.status,
        // `status`, or "overdue" for an unpaid invoice past its due date. Lists and badges show this.
        displayStatus: overdue ? "overdue" : inv.status,
        overdue,
        daysOverdue: overdue ? Math.round((Date.parse(today) - Date.parse(inv.dueDate)) / 86_400_000) : 0,
        branch: branch(inv.branch),
        customer: {
          ref: inv.customer?.ref ? String(inv.customer.ref) : null,
          name: inv.customer!.name,
          email: inv.customer?.email ?? null,
          phone: inv.customer?.phone ?? null,
          address: inv.customer?.address ?? null,
        },
        issueDate: inv.issueDate,
        dueDate: inv.dueDate,
        currency: inv.currency,
        totalKobo: inv.totalKobo,
        paidKobo: inv.paidKobo ?? 0,
        balanceKobo: balanceDue(inv),
        issuedAt: inv.issuedAt ?? null,
        lastSentAt: inv.lastSentAt ?? null,
        viewedAt: inv.viewedAt ?? null,
        paidAt: inv.paidAt ?? null,
        createdAt: inv.get("createdAt") as Date,
      };
      if (!detail) return base;
      return {
        ...base,
        items: inv.items.map((i) => ({ description: i.description, quantity: i.quantity, unitPriceKobo: i.unitPriceKobo, amountKobo: i.amountKobo })),
        subtotalKobo: inv.subtotalKobo,
        discount: inv.discount?.type
          ? inv.discount.type === "amount"
            ? { type: "amount" as const, amountKobo: inv.discount.value! }
            : { type: "percent" as const, percentBps: inv.discount.value! }
          : null,
        discountKobo: inv.discountKobo ?? 0,
        vatRateBps: inv.vatRateBps ?? null,
        vatKobo: inv.vatKobo ?? 0,
        notes: inv.notes ?? null,
        terms: inv.terms ?? null,
        footer: inv.footer ?? null,
        payments: inv.payments.map((p) => ({
          _id: String(p._id),
          amountKobo: p.amountKobo,
          method: p.method,
          transaction: p.transaction ? String(p.transaction) : null,
          auto: p.auto ?? false,
          note: p.note ?? null,
          paidAt: p.paidAt,
          recordedBy: user(p.recordedBy),
        })),
        lastSentTo: inv.lastSentTo ?? null,
        voidedAt: inv.voidedAt ?? null,
        receiptSentAt: inv.receiptSentAt ?? null,
        reminders: {
          enabled: inv.reminders?.enabled ?? true,
          sent: inv.reminders?.sent ?? [],
          lastSentAt: inv.reminders?.lastSentAt ?? null,
        },
        // Drafts aren't visible on the public link until they're sent.
        publicUrl: inv.status === "draft" ? null : publicInvoiceUrl(inv),
        payTo: await payToAccount(inv),
        createdBy: user(inv.createdBy),
      };
    }),
  );
}

const sendOne = async (res: Response, invoice: InvoiceDocument, status = 200) =>
  void res.status(status).json((await serialize([invoice], { detail: true }))[0]);

// ---- List and summary ----

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const listFilters = z.object({
  // "unpaid" = open or partly paid; "overdue" = unpaid and past due.
  status: z.enum([...INVOICE_STATUSES, "unpaid", "overdue"]).optional(),
  branch: objectId.optional(),
  customer: objectId.optional(),
  q: z.string().trim().max(100).optional(),
  // Issue date range, "YYYY-MM-DD" in Lagos.
  from: day.optional(),
  to: day.optional(),
  skip: z.coerce.number().int().min(0).default(0),
  take: z.coerce.number().int().min(1).max(100).default(20),
});

function scopeFilter(req: Request, branchId?: string) {
  assertBranchAccess(req, branchId);
  const scope = branchScope(req.membership!);
  const filter: Record<string, unknown> = { business: req.business!._id };
  if (branchId) filter.branch = new Types.ObjectId(branchId);
  else if (scope) filter.branch = { $in: scope };
  return filter;
}

export const listInvoices: RequestHandler = async (req, res) => {
  const f = listFilters.parse(req.query);
  const filter = scopeFilter(req, f.branch);
  const today = todayInLagos();
  if (f.status === "unpaid") filter.status = { $in: UNPAID_INVOICE_STATUSES };
  else if (f.status === "overdue") Object.assign(filter, { status: { $in: UNPAID_INVOICE_STATUSES }, dueDate: { $lt: today } });
  else if (f.status) filter.status = f.status;
  if (f.customer) filter["customer.ref"] = new Types.ObjectId(f.customer);
  if (f.from || f.to) filter.issueDate = { ...(f.from && { $gte: f.from }), ...(f.to && { $lte: f.to }) };
  if (f.q) {
    const re = new RegExp(escapeRegex(f.q), "i");
    filter.$or = [{ number: re }, { "customer.name": re }, { "customer.email": re }];
  }

  const [items, total] = await Promise.all([
    InvoiceModel.find(filter).sort({ createdAt: -1, _id: -1 }).skip(f.skip).limit(f.take),
    InvoiceModel.countDocuments(filter),
  ]);
  res.json({ items: await serialize(items), total, skip: f.skip, take: f.take });
};

/** Money owed (all unpaid), overdue, and collected this calendar month in Lagos; counts per status. */
export const getInvoiceSummary: RequestHandler = async (req, res) => {
  const { branch } = z.object({ branch: objectId.optional() }).parse(req.query);
  const match = scopeFilter(req, branch);
  const today = todayInLagos();
  const monthStart = new Date(`${today.slice(0, 7)}-01T00:00:00+01:00`);

  const [outstanding, collected, counts] = await Promise.all([
    InvoiceModel.aggregate<{ _id: null; outstandingKobo: number; overdueKobo: number; unpaidCount: number; overdueCount: number }>([
      { $match: { ...match, status: { $in: UNPAID_INVOICE_STATUSES } } },
      { $set: { balance: { $subtract: ["$totalKobo", "$paidKobo"] }, overdue: { $lt: ["$dueDate", today] } } },
      {
        $group: {
          _id: null,
          outstandingKobo: { $sum: "$balance" },
          overdueKobo: { $sum: { $cond: ["$overdue", "$balance", 0] } },
          unpaidCount: { $sum: 1 },
          overdueCount: { $sum: { $cond: ["$overdue", 1, 0] } },
        },
      },
    ]),
    InvoiceModel.aggregate<{ _id: null; kobo: number }>([
      { $match: { ...match, "payments.paidAt": { $gte: monthStart } } },
      { $unwind: "$payments" },
      { $match: { "payments.paidAt": { $gte: monthStart } } },
      { $group: { _id: null, kobo: { $sum: "$payments.amountKobo" } } },
    ]),
    InvoiceModel.aggregate<{ _id: string; count: number }>([{ $match: match }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
  ]);
  const o = outstanding[0];
  res.json({
    outstandingKobo: o?.outstandingKobo ?? 0,
    overdueKobo: o?.overdueKobo ?? 0,
    unpaidCount: o?.unpaidCount ?? 0,
    overdueCount: o?.overdueCount ?? 0,
    collectedThisMonthKobo: collected[0]?.kobo ?? 0,
    counts: Object.fromEntries(INVOICE_STATUSES.map((s) => [s, counts.find((c) => c._id === s)?.count ?? 0])),
    currency: "NGN",
  });
};

// ---- One invoice ----

export const getInvoice: RequestHandler<IdParams> = async (req, res) => {
  await sendOne(res, await findInvoice(req, req.params.id));
};

export const createInvoiceHandler: RequestHandler = async (req, res) => {
  // A draft can start without items; sending needs at least one.
  const body = z.object({ ...invoiceFields, items: invoiceFields.items.default([]) }).parse(req.body);
  assertBranchAccess(req, body.branch);
  const invoice = await createInvoice(req.business!, req.userId!, body);
  await sendOne(res, invoice, 201);
};

export const updateInvoiceHandler: RequestHandler<IdParams> = async (req, res) => {
  const body = z.object(invoiceFields).partial().parse(req.body);
  assertBranchAccess(req, body.branch);
  const invoice = await findInvoice(req, req.params.id);
  await sendOne(res, await updateInvoice(req.business!, invoice, body));
};

/** Only drafts can be deleted; issued invoices are voided so the numbering stays complete. */
export const deleteInvoice: RequestHandler<IdParams> = async (req, res) => {
  const invoice = await findInvoice(req, req.params.id);
  if (invoice.status !== "draft") throw new HttpError(409, "Only drafts can be deleted. Void a sent invoice instead.", "INVOICE_NOT_DRAFT");
  await invoice.deleteOne();
  res.status(204).end();
};

export const sendInvoiceHandler: RequestHandler<IdParams> = async (req, res) => {
  // email: false marks it as sent without emailing, to share the link another way.
  const body = z
    .object({ email: z.boolean().default(true), to: email.max(200).optional(), message: z.string().trim().max(1000).optional() })
    .parse(req.body ?? {});
  const invoice = await findInvoice(req, req.params.id);
  await sendOne(res, await sendInvoice(req.business!, invoice, body));
};

export const remindInvoice: RequestHandler<IdParams> = async (req, res) => {
  const invoice = await findInvoice(req, req.params.id);
  await sendOne(res, await remindNow(req.business!, invoice));
};

export const voidInvoiceHandler: RequestHandler<IdParams> = async (req, res) => {
  await sendOne(res, await voidInvoice(await findInvoice(req, req.params.id)));
};

export const duplicateInvoiceHandler: RequestHandler<IdParams> = async (req, res) => {
  const source = await findInvoice(req, req.params.id);
  await sendOne(res, await duplicateInvoice(req.business!, req.userId!, source), 201);
};

export const addPaymentHandler: RequestHandler<IdParams> = async (req, res) => {
  const body = z
    .union([
      z.object({ transactionId: objectId }),
      z.object({
        amountKobo: z.number().int().min(1),
        // "transfer" here is a transfer to an account outside LinkPay; ours are linked with transactionId.
        method: z.enum(PAYMENT_METHODS),
        paidAt: z.coerce.date().max(new Date(Date.now() + 60_000), "Can't be in the future").optional(),
        note: z.string().trim().max(300).optional(),
      }),
    ])
    .parse(req.body);
  const invoice = await findInvoice(req, req.params.id);
  if ("amountKobo" in body && body.amountKobo > balanceDue(invoice)) {
    throw new HttpError(400, "That's more than the balance due", "PAYMENT_TOO_LARGE", { balanceKobo: balanceDue(invoice) });
  }
  await sendOne(res, await addPayment(req.business!, invoice, req.userId!, body));
};

export const removePaymentHandler: RequestHandler<PaymentParams> = async (req, res) => {
  const invoice = await findInvoice(req, req.params.id);
  if (invoice.status === "void") throw new HttpError(409, "A void invoice can't be changed", "INVOICE_VOID");
  await sendOne(res, await removePayment(invoice, req.params.paymentId));
};

/** Unlinked incoming payments that might be for this invoice (exact balance or the customer's name). */
export const getSuggestedPayments: RequestHandler<IdParams> = async (req, res) => {
  const invoice = await findInvoice(req, req.params.id);
  const items = UNPAID_INVOICE_STATUSES.includes(invoice.status) ? await suggestPayments(invoice) : [];
  res.json({
    items: items.map((tx) => ({
      _id: tx.id as string,
      amountKobo: tx.amountKobo,
      counterparty: { name: tx.counterparty?.name ?? null, bankName: tx.counterparty?.bankName ?? null },
      narration: tx.narration ?? null,
      reference: tx.reference ?? null,
      occurredAt: tx.occurredAt,
      exactAmount: tx.amountKobo === balanceDue(invoice),
    })),
  });
};

/** The PDF. `?kind=receipt` for paid invoices; `?download=1` to save rather than open. */
export async function sendInvoicePdf(res: Response, business: Parameters<typeof renderInvoicePdf>[0], invoice: InvoiceDocument, query: unknown) {
  const q = z.object({ kind: z.enum(["invoice", "receipt"]).default("invoice"), download: z.string().optional() }).parse(query);
  if (q.kind === "receipt" && invoice.status !== "paid") throw new HttpError(409, "Receipts are for paid invoices", "INVOICE_NOT_PAID");
  const pdf = await renderInvoicePdf(business, invoice, { kind: q.kind, account: await payToAccount(invoice) });
  const name = `${q.kind === "receipt" ? "Receipt" : "Invoice"} ${invoice.number}.pdf`;
  res
    .type("application/pdf")
    .setHeader("Content-Disposition", `${q.download ? "attachment" : "inline"}; filename="${encodeURIComponent(name)}"`)
    .setHeader("Cache-Control", "private, no-store")
    .send(pdf);
}

export const getInvoicePdf: RequestHandler<IdParams> = async (req, res) => {
  const invoice = await findInvoice(req, req.params.id);
  await sendInvoicePdf(res, req.business!, invoice, req.query);
};

/** Defaults for a new invoice form: dates, VAT and text from the business's invoice settings. */
export const getInvoiceDefaults: RequestHandler = async (req, res) => {
  const s = req.business!.branding?.invoice;
  const issueDate = todayInLagos();
  res.json({
    issueDate,
    dueDate: addDays(issueDate, s?.defaultDueDays ?? 14),
    vatRateBps: s?.vatByDefault ? (s.vatRateBps ?? 750) : null,
    defaultVatRateBps: s?.vatRateBps ?? 750,
    notes: s?.notes ?? null,
    terms: s?.terms ?? null,
    footer: s?.footer ?? null,
    nextNumber: `${s?.prefix || "INV"}-${String((req.business!.invoiceSeq ?? 0) + 1).padStart(4, "0")}`,
  });
};

// ---- Customers (the business's address book for invoices) ----

export const listCustomers: RequestHandler = async (req, res) => {
  const f = z
    .object({ q: z.string().trim().max(100).optional(), skip: z.coerce.number().int().min(0).default(0), take: z.coerce.number().int().min(1).max(100).default(50) })
    .parse(req.query);
  const filter: Record<string, unknown> = { business: req.business!._id, archived: false };
  if (f.q) {
    const re = new RegExp(escapeRegex(f.q), "i");
    filter.$or = [{ name: re }, { email: re }, { phone: re }];
  }
  const [items, total] = await Promise.all([
    InvoiceCustomerModel.find(filter).collation({ locale: "en" }).sort({ name: 1 }).skip(f.skip).limit(f.take),
    InvoiceCustomerModel.countDocuments(filter),
  ]);
  res.json({ items, total, skip: f.skip, take: f.take });
};

async function findCustomer(req: Request, id: string) {
  if (!isValidObjectId(id)) throw new HttpError(400, "Invalid id");
  const found = await InvoiceCustomerModel.findOne({ _id: id, business: req.business!._id, archived: false });
  if (!found) throw new HttpError(404, "Customer not found", "CUSTOMER_NOT_FOUND");
  return found;
}

export const createCustomer: RequestHandler = async (req, res) => {
  const body = z.object(customerFields).parse(req.body);
  res.status(201).json(await InvoiceCustomerModel.create({ ...body, business: req.business!._id }));
};

/** Changes the saved details. Invoices already sent keep the details they were sent with. */
export const updateCustomer: RequestHandler<IdParams> = async (req, res) => {
  const body = z
    .object({ name: customerFields.name, email: email.nullable(), phone: phone.nullable(), address: z.string().trim().max(500).nullable() })
    .partial()
    .parse(req.body);
  const found = await findCustomer(req, req.params.id);
  for (const [key, value] of Object.entries(body)) found.set(key, value ?? undefined);
  await found.save();
  res.json(found);
};

/** Archives the customer (invoices keep pointing at it). */
export const deleteCustomer: RequestHandler<IdParams> = async (req, res) => {
  const found = await findCustomer(req, req.params.id);
  found.archived = true;
  await found.save();
  res.status(204).end();
};
