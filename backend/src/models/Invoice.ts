import { Schema, Types, model, type HydratedDocument, type InferSchemaType } from "mongoose";

export const INVOICE_STATUSES = [
  "draft", // being prepared; not visible on the public link
  "open", // issued (emailed or shared), nothing paid yet
  "partially_paid",
  "paid",
  "void", // cancelled after issuing; kept for the record
] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/** Statuses that still expect money. "Overdue" is one of these past its due date, not a stored status. */
export const UNPAID_INVOICE_STATUSES: InvoiceStatus[] = ["open", "partially_paid"];

export const PAYMENT_METHODS = ["transfer", "cash", "pos", "cheque", "other"] as const;

const itemSchema = new Schema(
  {
    description: { type: String, required: true, trim: true },
    quantity: { type: Number, required: true },
    unitPriceKobo: { type: Number, required: true },
    amountKobo: { type: Number, required: true }, // round(quantity × unit price)
  },
  { _id: false },
);

const paymentSchema = new Schema(
  {
    amountKobo: { type: Number, required: true, min: 1 },
    method: { type: String, enum: PAYMENT_METHODS, required: true },
    // Set when the payment is an incoming transfer on one of the business's accounts.
    transaction: { type: Types.ObjectId, ref: "Transaction" },
    // Matched automatically from the transfer's narration (as opposed to recorded by a team member).
    auto: { type: Boolean, default: false },
    note: { type: String, trim: true },
    paidAt: { type: Date, required: true },
    recordedBy: { type: Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

// Every amount is an integer in kobo. Totals are recomputed by services/invoices.ts on every change.
const invoiceSchema = new Schema(
  {
    business: { type: Types.ObjectId, ref: "Business", required: true },
    // The branch whose account the customer is asked to pay into.
    branch: { type: Types.ObjectId, ref: "Branch", required: true },
    number: { type: String, required: true }, // e.g. INV-0042
    seq: { type: Number, required: true },

    customer: {
      ref: { type: Types.ObjectId, ref: "InvoiceCustomer" },
      name: { type: String, required: true, trim: true },
      email: { type: String, lowercase: true, trim: true },
      phone: { type: String, trim: true },
      address: { type: String, trim: true },
    },

    // Calendar days in Lagos ("2026-10-20"), so "due today" never shifts with time zones.
    issueDate: { type: String, required: true },
    dueDate: { type: String, required: true },

    items: { type: [itemSchema], default: [] },
    currency: { type: String, default: "NGN" },
    subtotalKobo: { type: Number, required: true },
    // `value` is kobo for "amount" and basis points for "percent" (1000 = 10%).
    discount: {
      type: { type: String, enum: ["amount", "percent"] },
      value: { type: Number },
    },
    discountKobo: { type: Number, default: 0 },
    vatRateBps: { type: Number }, // unset = no VAT
    vatKobo: { type: Number, default: 0 },
    totalKobo: { type: Number, required: true },
    paidKobo: { type: Number, default: 0 },

    notes: { type: String, trim: true },
    terms: { type: String, trim: true },
    footer: { type: String, trim: true },

    status: { type: String, enum: INVOICE_STATUSES, default: "draft" },
    payments: { type: [paymentSchema], default: [] },

    // Unguessable id for the customer's public page and PDF (no sign-in).
    publicToken: { type: String, required: true, unique: true },

    issuedAt: { type: Date }, // first sent or marked as sent
    lastSentAt: { type: Date },
    lastSentTo: { type: String },
    viewedAt: { type: Date }, // first opened on the public page
    overdueNotifiedAt: { type: Date }, // the team was told it's overdue (cleared when the due date changes)
    paidAt: { type: Date },
    voidedAt: { type: Date },
    receiptSentAt: { type: Date },
    reminders: {
      enabled: { type: Boolean, default: true },
      // Automatic reminders already sent: "before_due", "due_today", "overdue_3", "overdue_10".
      sent: { type: [String], default: [] },
      lastSentAt: { type: Date },
    },
    createdBy: { type: Types.ObjectId, ref: "User", required: true },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (_doc, ret: Record<string, any>) => {
        delete ret.__v;
        return ret;
      },
    },
  },
);

invoiceSchema.index({ business: 1, number: 1 }, { unique: true });
invoiceSchema.index({ business: 1, createdAt: -1 });
invoiceSchema.index({ business: 1, status: 1, dueDate: 1 });
invoiceSchema.index({ status: 1, dueDate: 1 });

export type Invoice = InferSchemaType<typeof invoiceSchema>;
export type InvoiceDocument = HydratedDocument<Invoice>;
export const InvoiceModel = model("Invoice", invoiceSchema);
