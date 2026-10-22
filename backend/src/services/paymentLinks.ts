import { randomBytes, randomInt } from "node:crypto";
import type { Types } from "mongoose";
import { env } from "../config/env";
import { CHECKOUT_RULES } from "../config/paymentLinks";
import { BusinessModel, type BusinessDocument } from "../models/Business";
import { CheckoutModel, PaymentLinkModel, type CheckoutDocument, type PaymentLinkDocument } from "../models/PaymentLink";
import { TransactionModel, type TransactionDocument } from "../models/Transaction";
import { VirtualAccountModel } from "../models/VirtualAccount";
import { HttpError } from "../utils/HttpError";
import { accentPalette } from "./branding";
import { sendPaymentLinkReceiptEmail, type InvoiceBrand } from "./email";
import { publishLinkEvent } from "./linkStream";
import { paymentLinkPaid } from "./notificationEvents";

const MINUTE = 60_000;

// ---------------------------------------------------------------------------------------------------------
// Codes, addresses and states
// ---------------------------------------------------------------------------------------------------------

// No 0/O, 1/I/L: people read these aloud and type them into bank apps.
const SLUG_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const REFERENCE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const randomCode = (alphabet: string, length: number) => Array.from({ length }, () => alphabet[randomInt(alphabet.length)]).join("");

export const newSlug = () => randomCode(SLUG_ALPHABET, 10);
/** "LP-7K2Q9M" */
export const newReference = () => `LP-${randomCode(REFERENCE_ALPHABET, 6)}`;
export const newCheckoutToken = () => randomBytes(18).toString("base64url");

export const paymentLinkUrl = (link: { slug: string }) => `${env.webUrl}/pay/${link.slug}`;

/** How payer emails look: the business's name, accent and logo; replies go to the business. */
export function linkBrand(business: BusinessDocument, link: { slug: string }): InvoiceBrand {
  const { accent, onAccent } = accentPalette(business.branding?.accentColor);
  const logo = business.branding?.logo;
  return {
    businessName: business.name,
    replyTo: business.email ?? undefined,
    accent,
    onAccent,
    // The web serves the logo next to the public page (GET /api/public/pay/:slug/logo behind it).
    logoUrl: logo?.key ? `${paymentLinkUrl(link)}/logo?v=${logo.updatedAt?.getTime() ?? 0}` : null,
  };
}

export type UnavailableReason = "taken_down" | "inactive" | "expired" | "sold_out" | "account_not_ready";

/** Why the link can't take a new payment right now, or null when it can. */
export async function unavailableReason(link: PaymentLinkDocument, now = new Date()): Promise<UnavailableReason | null> {
  if (link.takenDown?.at) return "taken_down";
  if (link.status !== "active") return "inactive";
  if (link.expiresAt && link.expiresAt <= now) return "expired";
  if (link.maxPayments && link.paymentsCount >= link.maxPayments) return "sold_out";
  // Test checkouts show placeholder details, so a link can be tried before its account is open.
  if (link.mode !== "test" && !(await VirtualAccountModel.exists({ branch: link.branch }))) return "account_not_ready";
  return null;
}

// ---------------------------------------------------------------------------------------------------------
// Embedding on the business's website
// ---------------------------------------------------------------------------------------------------------

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
const isLocalHost = (hostname: string) => LOCAL_HOSTS.includes(hostname) || hostname.endsWith(".localhost");

/**
 * A website the business allows to embed a link, as an origin: "shop.adaeze.ng/checkout" becomes
 * "https://shop.adaeze.ng", "https://*.adaeze.ng" allows every subdomain. HTTPS only, except localhost for
 * testing. Null when it isn't a usable address.
 */
export function normalizeOrigin(input: string): string | null {
  let s = input.trim().toLowerCase();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = `https://${s}`;
  const wildcard = /^https?:\/\/\*\./.test(s);
  const PROBE = "wildcard-probe.";
  let url: URL;
  try {
    url = new URL(wildcard ? s.replace("*.", PROBE) : s);
  } catch {
    return null;
  }
  if (url.username || url.password || url.hostname.includes("*")) return null;
  const local = isLocalHost(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
  if (!local && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(url.hostname)) return null;
  if (wildcard) {
    const rest = url.host.slice(PROBE.length);
    // "*.ng" or "*.com.ng" would allow far too much.
    if (rest.split(":")[0]!.split(".").length < 2 || /^(com|org|gov|edu|net)\.[a-z]{2}$/.test(rest.split(":")[0]!)) return null;
    return `${url.protocol}//*.${rest}`;
  }
  return `${url.protocol}//${url.host}`;
}

/** Whether a page at `origin` may start an embedded checkout: always when the link allows any site. */
export function originAllowed(allowed: readonly string[], origin: string | null | undefined) {
  if (!allowed.length) return true;
  if (!origin) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const host = url.host.toLowerCase();
  return allowed.some((pattern) => {
    const [scheme, rest] = pattern.split("//") as [string, string];
    if (scheme !== url.protocol) return false;
    return rest.startsWith("*.") ? host.endsWith(rest.slice(1)) : host === rest;
  });
}

export const embedScriptUrl = () => `${env.webUrl}/embed.js`;

const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const nairaLabel = (kobo: number) =>
  `₦${(kobo / 100).toLocaleString("en-NG", { minimumFractionDigits: kobo % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;

/**
 * Copy-and-paste code for the business's website: a pay button (popup checkout), the page inline, and the
 * JavaScript call. The script and the page are the web's (WEB_URL/embed.js, WEB_URL/pay/<slug>).
 */
export function embedSnippets(link: Pick<PaymentLinkDocument, "slug" | "title" | "amountKobo">) {
  const url = paymentLinkUrl(link);
  const script = embedScriptUrl();
  const label = link.amountKobo ? `Pay ${nairaLabel(link.amountKobo)}` : "Pay now";
  return {
    url,
    scriptUrl: script,
    // Popup over the business's page; clicking the button opens the checkout.
    button: [
      `<script src="${script}" async></script>`,
      `<button type="button" data-linkpay-link="${link.slug}">${escapeAttr(label)}</button>`,
    ].join("\n"),
    // The checkout shown in place, in the page's flow.
    inline: `<iframe src="${url}?embed=inline" title="${escapeAttr(link.title)}" style="width:100%;max-width:480px;height:680px;border:0" allow="clipboard-write" loading="lazy"></iframe>`,
    // For sites that open the checkout from their own code (e.g. with the order id).
    javascript: [
      `<script src="${script}"></script>`,
      `<script>`,
      `  LinkPay.open({`,
      `    link: "${link.slug}",`,
      `    clientReference: "ORDER-1234", // your order id (optional)`,
      `    email: "customer@example.com", // prefills the form (optional)`,
      `    onSuccess: (checkout) => {`,
      `      // Confirm on your server: GET ${env.apiPublicUrl}/api/public/checkouts/\${checkout.token}`,
      `      // and check status "paid" and mode "live" (test payments move no money).`,
      `    },`,
      `    onClose: () => {},`,
      `  });`,
      `</script>`,
    ].join("\n"),
  };
}

/** The status clients see: a pending checkout past its time shows as "expired" (a late transfer still counts). */
export const checkoutStatus = (checkout: Pick<CheckoutDocument, "status" | "expiresAt">, now = new Date()) =>
  checkout.status === "pending" && checkout.expiresAt <= now ? ("expired" as const) : checkout.status;

/**
 * The account a test checkout shows instead of the branch's real one: plainly not a bank account, so nobody
 * sends real money to it while the business is trying the page out.
 */
export const testPayTo = (business: { name: string }) => ({
  accountNumber: "0000000000",
  accountName: `${business.name} (test)`,
  bankName: "Test bank: don't send money",
});

/** Frees unique amounts whose hold has ended, so new checkouts can use them. */
export async function releaseHolds(now = new Date()) {
  await CheckoutModel.updateMany({ amountReserved: true, holdUntil: { $lte: now } }, { $unset: { amountReserved: 1 } });
}

// ---------------------------------------------------------------------------------------------------------
// Starting a checkout
// ---------------------------------------------------------------------------------------------------------

export type PayerInput = {
  name: string;
  email: string;
  phone?: string;
  fields: { label: string; value: string }[];
  /** Donation links: hide the name on the public list, and words of support. */
  donor?: { anonymous: boolean; message?: string };
};

/** Where the checkout came from and what the business's website attached to it (embed). */
export type CheckoutContext = {
  source?: "page" | "embed";
  embedOrigin?: string;
  clientReference?: string;
  metadata?: Record<string, string>;
};

const isDuplicateOn = (err: any, field: string) => err?.code === 11000 && Object.keys(err.keyPattern ?? err.keyValue ?? {}).includes(field);

/**
 * Starts a checkout for `priceKobo`: picks a free unique amount on the branch's account (the price plus 1..99
 * kobo) and reserves it. A payer who already has an open checkout for the same price gets that one back.
 * On a test link the checkout has no account and reserves nothing (see `testPayTo`).
 */
export async function startCheckout(link: PaymentLinkDocument, payer: PayerInput, priceKobo: number, context: CheckoutContext = {}) {
  const test = link.mode === "test";
  const account = test ? null : await VirtualAccountModel.findOne({ branch: link.branch }).select("_id");
  if (!test && !account) throw new HttpError(409, "This business can't take payments yet. Please try again later.", "ACCOUNT_NOT_READY");
  const now = new Date();

  const extras = {
    source: context.source ?? "page",
    embedOrigin: context.embedOrigin || undefined,
    clientReference: context.clientReference || undefined,
    metadata: context.metadata && Object.keys(context.metadata).length ? context.metadata : undefined,
  };

  // Same person, same price, same order (if the website sent one), with at least 5 minutes left: give them
  // the same account details again. A different order reference is a different payment.
  const open = await CheckoutModel.findOne({
    link: link._id,
    "payer.email": payer.email.toLowerCase(),
    priceKobo,
    clientReference: extras.clientReference ?? null,
    // A link that has gone live never hands back a test checkout (or the other way round).
    mode: test ? "test" : { $ne: "test" },
    status: "pending",
    expiresAt: { $gt: new Date(now.getTime() + 5 * MINUTE) },
  }).sort({ createdAt: -1 });
  const { donor, ...person } = payer;
  if (open) {
    open.set("payer", { ...person, email: person.email.toLowerCase() });
    if (donor) open.set("donor", donor);
    open.set({ source: extras.source, embedOrigin: extras.embedOrigin, metadata: extras.metadata });
    await open.save();
    return { checkout: open, reused: true };
  }

  const fields = {
    business: link.business,
    branch: link.branch,
    link: link._id,
    payer: person,
    ...(donor && { donor }),
    priceKobo,
    ...extras,
    expiresAt: new Date(now.getTime() + CHECKOUT_RULES.payWithinMinutes * MINUTE),
    holdUntil: new Date(now.getTime() + CHECKOUT_RULES.amountHoldMinutes * MINUTE),
  };

  if (!account) {
    // Test mode: no real account to tell transfers apart on, but the payer still sees an amount like a live one.
    for (let attempt = 0; ; attempt++) {
      try {
        const amountKobo = priceKobo + randomInt(1, CHECKOUT_RULES.maxOffsetKobo + 1);
        const checkout = await CheckoutModel.create({ ...fields, mode: "test", token: newCheckoutToken(), reference: newReference(), amountKobo });
        return { checkout, reused: false };
      } catch (err) {
        if (attempt < 3 && (isDuplicateOn(err, "reference") || isDuplicateOn(err, "token"))) continue;
        throw err;
      }
    }
  }

  await releaseHolds(now);
  const reserved = await CheckoutModel.find({
    virtualAccount: account._id,
    amountReserved: true,
    amountKobo: { $gt: priceKobo, $lte: priceKobo + CHECKOUT_RULES.maxOffsetKobo },
  }).select("amountKobo");
  const taken = new Set(reserved.map((c) => c.amountKobo - priceKobo));
  const free = Array.from({ length: CHECKOUT_RULES.maxOffsetKobo }, (_, i) => i + 1).filter((o) => !taken.has(o));
  // Random order, so the amounts don't hint at how many people are paying.
  for (let i = free.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [free[i], free[j]] = [free[j]!, free[i]!];
  }

  for (const offset of free.slice(0, 5)) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const checkout = await CheckoutModel.create({
          ...fields,
          mode: "live",
          virtualAccount: account._id,
          token: newCheckoutToken(),
          reference: newReference(),
          amountKobo: priceKobo + offset,
          amountReserved: true,
        });
        return { checkout, reused: false };
      } catch (err) {
        // Someone else took this amount a moment ago: try the next one.
        if (isDuplicateOn(err, "amountKobo")) break;
        // A reference or token clash (very unlikely): same amount, new codes.
        if (isDuplicateOn(err, "reference") || isDuplicateOn(err, "token")) continue;
        throw err;
      }
    }
  }
  throw new HttpError(503, "Lots of people are paying this amount right now. Please try again in a few minutes.", "CHECKOUT_BUSY");
}

// ---------------------------------------------------------------------------------------------------------
// Settling: a transfer (or, in test mode, a simulated payment) pays a checkout
// ---------------------------------------------------------------------------------------------------------

/** What paid a checkout: an incoming transfer (which must already point at it), or a simulated payment (no `_id`). */
type Payment = { _id?: Types.ObjectId; amountKobo: number; occurredAt: Date };

/**
 * Marks the checkout as paid by `tx`, updates the link's totals (live payments only), and tells the team and
 * the payer. Returns null when the checkout was no longer pending.
 */
async function settleCheckout(checkoutId: Types.ObjectId, tx: Payment, matchedBy: "amount" | "reference" | "manual" | "simulated", userId?: string) {
  const current = await CheckoutModel.findById(checkoutId).select("priceKobo link");
  if (!current) return null;
  const kind = (await PaymentLinkModel.findById(current.link).select("kind"))?.kind;
  // A donation is whatever arrives: less than the donor first typed is still a donation, not a part payment.
  const status = kind === "donation" || tx.amountKobo >= current.priceKobo ? "paid" : "underpaid";
  const checkout = await CheckoutModel.findOneAndUpdate(
    { _id: checkoutId, status: "pending" },
    {
      $set: { status, ...(tx._id && { transaction: tx._id }), matchedBy, paidKobo: tx.amountKobo, paidAt: tx.occurredAt, ...(userId && { matchedByUser: userId }) },
      $unset: { amountReserved: 1 },
    },
    { returnDocument: "after" },
  );
  if (!checkout) return null;

  // Test payments never count towards the link's totals or its payment limit.
  const link =
    checkout.mode === "test"
      ? await PaymentLinkModel.findById(checkout.link)
      : await PaymentLinkModel.findOneAndUpdate(
          { _id: checkout.link },
          { $inc: { paymentsCount: 1, collectedKobo: tx.amountKobo }, $max: { lastPaidAt: tx.occurredAt } },
          { returnDocument: "after" },
        );
  if (link) {
    // Open pages pull in the new donation and re-check their own checkout; a link that just reached its
    // payment limit also tells them it's sold out.
    publishLinkEvent(link._id, "paid");
    if (link.maxPayments && link.paymentsCount >= link.maxPayments) publishLinkEvent(link._id, "link");
  }
  const business = await BusinessModel.findById(checkout.business);
  if (link && business) {
    await paymentLinkPaid(business, link, checkout);
    if (checkout.status === "paid") {
      try {
        await sendPaymentLinkReceiptEmail(checkout.payer!.email, {
          brand: linkBrand(business, link),
          title: link.title,
          payerName: checkout.payer!.name,
          paidKobo: tx.amountKobo,
          reference: checkout.reference,
          paidAt: tx.occurredAt,
          message: link.successMessage,
          clientReference: checkout.clientReference,
          donation: link.kind === "donation",
          test: checkout.mode === "test",
        });
        await CheckoutModel.updateOne({ _id: checkout._id }, { receiptSentAt: new Date() });
      } catch (err) {
        console.error(`Couldn't send the receipt for checkout ${checkout.id}:`, err);
      }
    }
  }
  return checkout;
}

/** Letters and digits only, upper case: "lp-7k2q 9m" becomes "LP7K2Q9M". */
const squash = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
const REFERENCE_IN_TEXT = new RegExp(`LP([${REFERENCE_ALPHABET}]{6})`, "g");

/** Every checkout reference that could be in this narration ("LP-7K2Q9M", "lp7k2q9m", "LP 7K2Q9M"). */
export function referencesInText(text: string) {
  return [...squash(text).matchAll(REFERENCE_IN_TEXT)].map((m) => `LP-${m[1]}`);
}

/** The pending checkout this transfer pays, and how we know; null when there's none or it's ambiguous. */
async function findCheckoutFor(tx: TransactionDocument) {
  const occurred = tx.occurredAt.getTime();
  const references = referencesInText([tx.narration, tx.reference].filter(Boolean).join(" "));
  if (references.length) {
    const byReference = await CheckoutModel.findOne({
      reference: { $in: references },
      virtualAccount: tx.virtualAccount,
      mode: { $ne: "test" },
      status: "pending",
      createdAt: {
        $gte: new Date(occurred - CHECKOUT_RULES.referenceMatchDays * 24 * 60 * MINUTE),
        $lte: new Date(occurred + CHECKOUT_RULES.clockSlackMinutes * MINUTE),
      },
    }).select("_id");
    if (byReference) return { id: byReference._id, by: "reference" as const };
  }
  // The exact unique amount, sent while it was held for that checkout.
  const byAmount = await CheckoutModel.find({
    virtualAccount: tx.virtualAccount,
    amountKobo: tx.amountKobo,
    mode: { $ne: "test" },
    status: "pending",
    createdAt: { $lte: new Date(occurred + CHECKOUT_RULES.clockSlackMinutes * MINUTE) },
    holdUntil: { $gte: tx.occurredAt },
  })
    .select("_id")
    .limit(2);
  return byAmount.length === 1 ? { id: byAmount[0]!._id, by: "amount" as const } : null;
}

/**
 * Links new successful incoming transfers to the payment-link checkouts they pay: the reference in the
 * narration, or else the checkout's exact unique amount. Each transfer is looked at once; runs after every
 * inbound sync, before the invoice matcher (a transfer that pays a checkout isn't an invoice payment).
 */
export async function matchCheckoutPayments() {
  await releaseHolds();
  const pending = await TransactionModel.find({ direction: "credit", status: "success", checkoutCheckedAt: { $exists: false } }).limit(1000);
  let matched = 0;
  for (const tx of pending) {
    try {
      const hit = tx.invoice ? null : await findCheckoutFor(tx);
      const now = new Date();
      // Claim it atomically. A matched transfer is also marked as checked for invoices.
      const claimed = await TransactionModel.findOneAndUpdate(
        { _id: tx._id, checkoutCheckedAt: { $exists: false }, ...(hit && { invoice: { $exists: false } }) },
        { checkoutCheckedAt: now, ...(hit && { checkout: hit.id, invoiceCheckedAt: now }) },
      );
      if (!hit) continue;
      if (!claimed) {
        // Linked to an invoice in the meantime.
        await TransactionModel.updateOne({ _id: tx._id, checkoutCheckedAt: { $exists: false } }, { checkoutCheckedAt: now });
        continue;
      }
      if (await settleCheckout(hit.id, tx, hit.by)) matched++;
      else await TransactionModel.updateOne({ _id: tx._id }, { $unset: { checkout: 1, invoiceCheckedAt: 1 } });
    } catch (err) {
      console.error(`Couldn't match payment ${tx.id} to a checkout:`, err);
    }
  }
  return { checked: pending.length, matched };
}

/** A team member links an incoming transfer the matcher missed (e.g. a round amount with no reference). */
export async function linkTransactionToCheckout(checkout: CheckoutDocument, transactionId: string, userId: string) {
  if (checkout.mode === "test") throw new HttpError(409, "A test checkout can't be paid with a real payment", "CHECKOUT_IS_TEST");
  if (checkout.status !== "pending") throw new HttpError(409, "This checkout has already been paid", "CHECKOUT_NOT_PENDING");
  const tx = await TransactionModel.findOne({ _id: transactionId, business: checkout.business, direction: "credit", status: "success" });
  if (!tx) throw new HttpError(404, "Payment not found", "TRANSACTION_NOT_FOUND");
  const claimed = await TransactionModel.findOneAndUpdate(
    { _id: tx._id, checkout: { $exists: false }, invoice: { $exists: false } },
    { checkout: checkout._id, checkoutCheckedAt: new Date(), invoiceCheckedAt: new Date() },
  );
  if (!claimed) throw new HttpError(409, "That payment is already linked to an invoice or another checkout", "TRANSACTION_ALREADY_LINKED");
  const settled = await settleCheckout(checkout._id, tx, "manual", userId);
  if (!settled) {
    await TransactionModel.updateOne({ _id: tx._id }, { $unset: { checkout: 1 } });
    throw new HttpError(409, "This checkout has already been paid", "CHECKOUT_NOT_PENDING");
  }
  return settled;
}

/**
 * Test mode: pays a test checkout as if the transfer had arrived, with the exact amount (`paid`) or half the
 * price (`underpaid`, as if the payer sent too little and named the reference). Same notification and
 * receipt as a live payment, marked as a test. A pending checkout past its time can still be paid, like a
 * late transfer.
 */
export async function simulateCheckoutPayment(checkout: CheckoutDocument, outcome: "paid" | "underpaid", userId?: string) {
  if (checkout.mode !== "test") throw new HttpError(409, "Only test checkouts can be paid with a simulated payment", "CHECKOUT_IS_LIVE");
  const notPending = new HttpError(409, "This checkout has already been paid", "CHECKOUT_NOT_PENDING");
  if (checkout.status !== "pending") throw notPending;
  const amountKobo = outcome === "paid" ? checkout.amountKobo : Math.floor(checkout.priceKobo / 2);
  const settled = await settleCheckout(checkout._id, { amountKobo, occurredAt: new Date() }, "simulated", userId);
  if (!settled) throw notPending;
  return settled;
}

/** Incoming payments that look like they're for this checkout: its price or amount, or the payer's name. */
export async function suggestCheckoutPayments(checkout: CheckoutDocument) {
  // A test checkout has no account, and real payments never pay it.
  if (checkout.mode === "test" || !checkout.virtualAccount) return [];
  const words = checkout.payer!.name.split(/\s+/).filter((w) => w.length >= 3).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return TransactionModel.find({
    business: checkout.business,
    virtualAccount: checkout.virtualAccount,
    direction: "credit",
    status: "success",
    checkout: { $exists: false },
    invoice: { $exists: false },
    occurredAt: { $gte: new Date(checkout.get("createdAt").getTime() - CHECKOUT_RULES.clockSlackMinutes * MINUTE) },
    $or: [
      { amountKobo: { $in: [checkout.priceKobo, checkout.amountKobo] } },
      ...(words.length ? [{ "counterparty.name": new RegExp(words.join("|"), "i") }] : []),
    ],
  })
    .sort({ occurredAt: -1 })
    .limit(10);
}
