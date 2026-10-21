import { Schema, Types, model, type HydratedDocument, type InferSchemaType } from "mongoose";

export const PAYMENT_LINK_STATUSES = ["active", "inactive"] as const;
export const PHONE_FIELD_MODES = ["off", "optional", "required"] as const;
/** Where a checkout was started: the link's own page, or the page embedded on the business's website. */
export const CHECKOUT_SOURCES = ["page", "embed"] as const;

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
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    // Unguessable, URL-safe and permanent: the public page's address.
    slug: { type: String, required: true, unique: true },
    // Kobo. Set = everyone pays this; unset = the payer types an amount (at least `minAmountKobo`, if set).
    amountKobo: { type: Number },
    minAmountKobo: { type: Number },
    // What the page asks for besides the payer's name and email (always asked).
    phone: { type: String, enum: PHONE_FIELD_MODES, default: "optional" },
    customFields: { type: [customFieldSchema], default: [] },
    // Pictures, in order (the first is the cover); see PaymentLinkImage below.
    images: { type: [{ type: Types.ObjectId, ref: "PaymentLinkImage" }], default: [] },
    // Shown once the payment is confirmed; the payer is then sent to `redirectUrl`, if set.
    successMessage: { type: String, trim: true },
    redirectUrl: { type: String, trim: true },
    status: { type: String, enum: PAYMENT_LINK_STATUSES, default: "active" },
    // Websites allowed to embed the page ("https://shop.adaeze.ng", "https://*.adaeze.ng"); empty = any site.
    // The web turns this into the page's `frame-ancestors`; embedded checkouts from other sites are refused.
    allowedOrigins: { type: [String], default: [] },
    // Optional stops: no new checkouts after this moment, or once this many payments have come in.
    expiresAt: { type: Date },
    maxPayments: { type: Number },
    // Running totals of confirmed payments (paid or underpaid checkouts), kept by services/paymentLinks.ts.
    paymentsCount: { type: Number, default: 0 },
    collectedKobo: { type: Number, default: 0 },
    lastPaidAt: { type: Date },
    createdBy: { type: Types.ObjectId, ref: "User", required: true },
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
    virtualAccount: { type: Types.ObjectId, ref: "VirtualAccount", required: true },
    link: { type: Types.ObjectId, ref: "PaymentLink", required: true },
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
    // The incoming transfer that paid it, how it was matched, and what arrived.
    transaction: { type: Types.ObjectId, ref: "Transaction" },
    matchedBy: { type: String, enum: ["amount", "reference", "manual"] },
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
