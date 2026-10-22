import { Schema, Types, model, type HydratedDocument, type InferSchemaType } from "mongoose";
import { LINK_REPORT_REASON_KEYS } from "../config/paymentLinks";

export const PAYMENT_LINK_STATUSES = ["active", "inactive"] as const;
export const PHONE_FIELD_MODES = ["off", "optional", "required"] as const;
/** `payment`: an ordinary pay page. `donation`: a fundraiser (donor chooses, optional goal, public donor list). */
export const PAYMENT_LINK_KINDS = ["payment", "donation"] as const;
export type PaymentLinkKind = (typeof PAYMENT_LINK_KINDS)[number];
/** Where a checkout was started: the link's own page, or the page embedded on the business's website. */
export const CHECKOUT_SOURCES = ["page", "embed"] as const;
/**
 * "test": checkouts show placeholder bank details, are never matched to real transfers and are paid with a
 * simulated payment, so a business can try the page and its website integration without moving money.
 * Links and checkouts saved before test mode have no `mode`: they're live.
 */
export const PAYMENT_MODES = ["live", "test"] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];

const customFieldSchema = new Schema({
  label: { type: String, required: true, trim: true },
  required: { type: Boolean, default: false },
});

// A shareable page (WEB_URL/pay/<slug>) where anyone can pay the business by bank transfer into one branch's
// account. Each payer starts a Checkout (below); the link only holds the settings and running totals.
const paymentLinkSchema = new Schema(
  {
    business: { type: Types.ObjectId, ref: "Business", required: true },
    // The branch whose account payers send money to.
    branch: { type: Types.ObjectId, ref: "Branch", required: true },
    // Fixed when the link is made. Donation links never have a fixed amount.
    kind: { type: String, enum: PAYMENT_LINK_KINDS, default: "payment" },
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    // Unguessable, URL-safe and permanent: the public page's address.
    slug: { type: String, required: true, unique: true },
    // Kobo. Set = everyone pays this; unset = the payer types an amount (at least `minAmountKobo`, if set).
    amountKobo: { type: Number },
    minAmountKobo: { type: Number },
    // Donation links: the target shown with a progress bar (optional; donations keep coming after it's
    // reached), and quick-pick amounts on the page.
    goalKobo: { type: Number },
    suggestedAmountsKobo: { type: [Number], default: undefined },
    // What the page asks for besides the payer's name and email (always asked).
    phone: { type: String, enum: PHONE_FIELD_MODES, default: "optional" },
    customFields: { type: [customFieldSchema], default: [] },
    // Pictures, in order (the first is the cover); see PaymentLinkImage below.
    images: { type: [{ type: Types.ObjectId, ref: "PaymentLinkImage" }], default: [] },
    // Shown once the payment is confirmed; the payer is then sent to `redirectUrl`, if set.
    successMessage: { type: String, trim: true },
    redirectUrl: { type: String, trim: true },
    status: { type: String, enum: PAYMENT_LINK_STATUSES, default: "active" },
    // Can be switched either way; each checkout keeps the mode it was started in.
    mode: { type: String, enum: PAYMENT_MODES, default: "live" },
    // Websites allowed to embed the page ("https://shop.adaeze.ng", "https://*.adaeze.ng"); empty = any site.
    // The web turns this into the page's `frame-ancestors`; embedded checkouts from other sites are refused.
    allowedOrigins: { type: [String], default: [] },
    // Optional stops: no new checkouts after this moment, or once this many payments have come in.
    expiresAt: { type: Date },
    maxPayments: { type: Number },
    // Running totals of confirmed live payments (paid or underpaid checkouts), kept by services/paymentLinks.ts.
    paymentsCount: { type: Number, default: 0 },
    collectedKobo: { type: Number, default: 0 },
    lastPaidAt: { type: Date },
    createdBy: { type: Types.ObjectId, ref: "User", required: true },
    // Set when LinkPay staff take the link down (usually after a report). The public page stops taking
    // payments and the business can't turn it back on; only staff can restore it. Separate from `status`,
    // so a restored link goes back to how the business left it.
    takenDown: {
      at: { type: Date },
      by: { type: Types.ObjectId, ref: "Staff" },
      note: { type: String, trim: true },
    },
  },
  { timestamps: true },
);

paymentLinkSchema.index({ business: 1, createdAt: -1 });

export type PaymentLink = InferSchemaType<typeof paymentLinkSchema>;
export type PaymentLinkDocument = HydratedDocument<PaymentLink>;
export const PaymentLinkModel = model("PaymentLink", paymentLinkSchema);

export const CHECKOUT_STATUSES = [
  "pending", // waiting for the transfer ("expired" to clients once `expiresAt` passes)
  "paid", // a transfer of at least the price arrived
  "underpaid", // a transfer naming the reference arrived, for less than the price
] as const;
export type CheckoutStatus = (typeof CHECKOUT_STATUSES)[number];

// One payer's attempt to pay through a link: who they are, the exact amount to send and where.
const checkoutSchema = new Schema(
  {
    business: { type: Types.ObjectId, ref: "Business", required: true },
    branch: { type: Types.ObjectId, ref: "Branch", required: true },
    // Where the money goes. Test checkouts have none: they show placeholder details and match no transfer.
    virtualAccount: { type: Types.ObjectId, ref: "VirtualAccount" },
    link: { type: Types.ObjectId, ref: "PaymentLink", required: true },
    // The link's mode when the checkout started.
    mode: { type: String, enum: PAYMENT_MODES, default: "live" },
    // Test checkouts only: set when the link went live, which clears its test payments from every list and
    // figure (kept, not deleted, so an old notification still opens the checkout).
    testClearedAt: { type: Date },
    // Unguessable id for the payer's status page (no sign-in).
    token: { type: String, required: true, unique: true },
    // "LP-7K2Q9M": the payer may put it in the transfer's narration.
    reference: { type: String, required: true, unique: true },
    payer: {
      name: { type: String, required: true, trim: true },
      email: { type: String, required: true, lowercase: true, trim: true },
      phone: { type: String, trim: true },
      // Answers to the link's custom fields, with the label as it was when they paid.
      fields: { type: [{ _id: false, label: String, value: String }], default: [] },
    },
    // Donation links: whether the donor's name is hidden on the public list (the business still sees it),
    // and their words of support.
    donor: {
      anonymous: { type: Boolean },
      message: { type: String, trim: true },
    },
    // Staff took this donation off the public list (e.g. after a report about its message). Still counts.
    hidden: {
      at: { type: Date },
      by: { type: Types.ObjectId, ref: "Staff" },
      note: { type: String, trim: true },
    },
    // Kobo. `priceKobo` is what the payer owes; `amountKobo` adds 1..99 kobo so the transfer can be told apart.
    priceKobo: { type: Number, required: true },
    amountKobo: { type: Number, required: true },
    // Started on the link's page or from the business's website (embed), and which site.
    source: { type: String, enum: CHECKOUT_SOURCES, default: "page" },
    embedOrigin: { type: String },
    // The business's own order id and extra data, passed by its website and handed back with the checkout.
    clientReference: { type: String, trim: true },
    metadata: { type: Map, of: String },
    // True while `amountKobo` is reserved on this account (unique among reserved checkouts). Cleared once
    // paid or after `holdUntil`, so the amount can be used again.
    amountReserved: { type: Boolean },
    expiresAt: { type: Date, required: true },
    holdUntil: { type: Date, required: true },
    status: { type: String, enum: CHECKOUT_STATUSES, default: "pending" },
    // The incoming transfer that paid it (none for test checkouts), how it was matched, and what arrived.
    transaction: { type: Types.ObjectId, ref: "Transaction" },
    // "simulated": a test checkout marked paid by the payer's or a team member's simulated payment.
    matchedBy: { type: String, enum: ["amount", "reference", "manual", "simulated"] },
    matchedByUser: { type: Types.ObjectId, ref: "User" },
    paidKobo: { type: Number },
    paidAt: { type: Date },
    receiptSentAt: { type: Date },
  },
  { timestamps: true },
);

checkoutSchema.index({ business: 1, createdAt: -1 });
checkoutSchema.index({ link: 1, createdAt: -1 });
// One reserved checkout per exact amount on an account: this is what makes amount matching unambiguous.
checkoutSchema.index({ virtualAccount: 1, amountKobo: 1 }, { unique: true, partialFilterExpression: { amountReserved: true } });
checkoutSchema.index({ amountReserved: 1, holdUntil: 1 }, { partialFilterExpression: { amountReserved: true } });
// A payer refreshing the page gets their open checkout back instead of a new one.
checkoutSchema.index({ link: 1, "payer.email": 1, status: 1, expiresAt: 1 });
// The public donor list of a donation link: newest and largest first.
checkoutSchema.index({ link: 1, status: 1, paidAt: -1, _id: -1 });
checkoutSchema.index({ link: 1, status: 1, paidKobo: -1, _id: -1 });
checkoutSchema.index({ business: 1, clientReference: 1 }, { partialFilterExpression: { clientReference: { $exists: true } } });

export type Checkout = InferSchemaType<typeof checkoutSchema>;
export type CheckoutDocument = HydratedDocument<Checkout>;
export const CheckoutModel = model("Checkout", checkoutSchema);

// A picture uploaded for a payment link (a product photo, a book cover). Uploaded before the link exists, so
// the create form can take pictures; `link` is set once it's attached. Stored as WebP we produced ourselves.
const paymentLinkImageSchema = new Schema(
  {
    business: { type: Types.ObjectId, ref: "Business", required: true },
    link: { type: Types.ObjectId, ref: "PaymentLink" },
    key: { type: String, required: true },
    width: { type: Number, required: true },
    height: { type: Number, required: true },
    uploadedBy: { type: Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

// A link's pictures, and (link missing) uploads nobody attached, oldest first, for the daily cleanup.
paymentLinkImageSchema.index({ link: 1, createdAt: 1 });

export type PaymentLinkImage = InferSchemaType<typeof paymentLinkImageSchema>;
export type PaymentLinkImageDocument = HydratedDocument<PaymentLinkImage>;
export const PaymentLinkImageModel = model("PaymentLinkImage", paymentLinkImageSchema);

export const LINK_REPORT_STATUSES = ["open", "resolved"] as const;
/** `dismissed`: nothing wrong found. `actioned`: staff did something (took the link down, hid a donation, flagged the business). */
export const LINK_REPORT_OUTCOMES = ["dismissed", "actioned"] as const;

// Someone on the public page told LinkPay a link (usually a fundraiser), or one donation on its list, looks
// wrong. Staff review it in admin/. The business never sees reports.
const linkReportSchema = new Schema(
  {
    business: { type: Types.ObjectId, ref: "Business", required: true },
    link: { type: Types.ObjectId, ref: "PaymentLink", required: true },
    // A donation on the list this report is about (its message or name), if any.
    checkout: { type: Types.ObjectId, ref: "Checkout" },
    reason: { type: String, enum: LINK_REPORT_REASON_KEYS, required: true },
    details: { type: String, trim: true },
    // Optional, so staff can follow up.
    reporter: {
      name: { type: String, trim: true },
      email: { type: String, lowercase: true, trim: true },
      ip: { type: String },
    },
    status: { type: String, enum: LINK_REPORT_STATUSES, default: "open" },
    resolution: {
      outcome: { type: String, enum: LINK_REPORT_OUTCOMES },
      note: { type: String, trim: true },
      // What was done along with it.
      actions: { type: [String], default: undefined },
      flag: { type: Types.ObjectId, ref: "ComplianceFlag" },
      by: { type: Types.ObjectId, ref: "Staff" },
      at: { type: Date },
    },
  },
  { timestamps: true },
);

linkReportSchema.index({ status: 1, _id: -1 });
linkReportSchema.index({ link: 1, status: 1 });
linkReportSchema.index({ business: 1, _id: -1 });

export type LinkReport = InferSchemaType<typeof linkReportSchema>;
export type LinkReportDocument = HydratedDocument<LinkReport>;
export const LinkReportModel = model("LinkReport", linkReportSchema, "linkReports");
