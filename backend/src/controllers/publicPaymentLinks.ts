import type { RequestHandler, Response } from "express";
import { ipKeyGenerator } from "express-rate-limit";
import { z } from "zod";
import { CHECKOUT_RULES, DONATION_LIMITS, EMBED_LIMITS, LINK_REPORT_LIMITS, LINK_REPORT_REASON_KEYS, PAYMENT_LINK_LIMITS } from "../config/paymentLinks";
import { DONATION_SORTS, listPublicDonations, publicDonationProgress, reportLink } from "../services/donations";
import { BusinessModel, type BusinessDocument } from "../models/Business";
import { CHECKOUT_SOURCES, CheckoutModel, PaymentLinkModel, type CheckoutDocument, type PaymentLinkDocument } from "../models/PaymentLink";
import { VirtualAccountModel } from "../models/VirtualAccount";
import { accentPalette } from "../services/branding";
import { checkoutPayable, checkoutStatus, originAllowed, simulateCheckoutPayment, startCheckout, testPayTo, unavailableReason } from "../services/paymentLinks";
import { PaymentLinkImageModel } from "../models/PaymentLink";
import { describePublicImage, linkImages, sendLinkImage } from "../services/paymentLinkImages";
import { syncIfStale } from "../services/transactions";
import { serveLinkStream } from "../services/linkStream";
import { HttpError } from "../utils/HttpError";
import { PUBLIC_LOGO_CACHE, sendLogo } from "./branding";

type SlugParams = { slug: string };
type TokenParams = { token: string };

// A pending checkout's page polls; each poll pulls new transfers from Liquifia at most this often.
const SYNC_MAX_AGE_MS = 30_000;
const SYNC_WAIT_MS = 2_000;

const isRestricted = (business: BusinessDocument) =>
  business.compliance?.status === "suspended" || business.compliance?.status === "banned";

const SLUG = /^[a-z0-9-]{6,40}$/;

/** The link behind a public address. A suspended or closed business's links are taken down. */
async function findPublicLink(slug: string) {
  const notFound = new HttpError(404, "Payment link not found", "PAYMENT_LINK_NOT_FOUND");
  if (!SLUG.test(slug)) throw notFound;
  const link = await PaymentLinkModel.findOne({ slug });
  const business = link && (await BusinessModel.findById(link.business));
  if (!link || !business || isRestricted(business)) throw notFound;
  return { link, business };
}

/**
 * LinkPay staff took the link down (often a scam fundraiser): its address still answers with the title and
 * "no longer available", but its story, pictures, logo and donors are no longer published.
 */
const isTakenDown = (link: PaymentLinkDocument) => !!link.takenDown?.at;

function describeBusiness(business: BusinessDocument, link: PaymentLinkDocument) {
  const logo = isTakenDown(link) ? undefined : business.branding?.logo;
  return {
    name: business.name,
    // Relative to the API; the web proxies it at /pay/:slug/logo.
    logo: logo?.key ? { url: `/api/public/pay/${link.slug}/logo?v=${logo.updatedAt?.getTime() ?? 0}`, width: logo.width, height: logo.height } : null,
    palette: accentPalette(business.branding?.accentColor),
  };
}

/**
 * The payer's view of a checkout: what to send, where, and whether it has arrived. The business's server
 * also confirms a payment with this, through GET pay/:slug/checkouts/:token (which only answers for its own
 * link): it must check `status`, `mode`, `priceKobo`, `paidKobo`, `currency`, `clientReference` and (limited
 * stock) `overLimit` against its own order (see `embedSnippets`). The older GET checkouts/:token answers for any
 * link, so `link.slug` too.
 */
async function describeCheckout(checkout: CheckoutDocument, link: PaymentLinkDocument, business: BusinessDocument) {
  const status = checkoutStatus(checkout);
  const received = status === "paid" || status === "underpaid";
  const test = checkout.mode === "test";
  const takenDown = isTakenDown(link);
  // Once the hold on its amount ends, a pending checkout shows neither the account nor the amount: the amount
  // can be handed to another payer's checkout, and a transfer of it would then pay theirs.
  const payable = checkoutPayable(checkout);
  // Only while waiting for the money, and never for a business that's been suspended since or a link LinkPay
  // has taken down. Test checkouts show placeholder details, never the branch's real account.
  const waiting = payable && !isRestricted(business) && !takenDown;
  const account =
    waiting && !test && checkout.virtualAccount
      ? await VirtualAccountModel.findById(checkout.virtualAccount).select("accountNumber accountName bankName")
      : null;
  const [cover] = takenDown ? [] : await linkImages({ images: (link.images ?? []).slice(0, 1) });
  let redirectUrl: string | null = null;
  if (status === "paid" && link.redirectUrl && !takenDown) {
    const url = new URL(link.redirectUrl);
    url.searchParams.set("reference", checkout.reference);
    url.searchParams.set("status", "paid");
    if (checkout.clientReference) url.searchParams.set("client_reference", checkout.clientReference);
    if (test) url.searchParams.set("mode", "test");
    redirectUrl = url.toString();
  }
  return {
    token: checkout.token,
    reference: checkout.reference,
    status,
    // "test": nothing to send; the page offers to simulate the payment. A business's server must only fulfil "live".
    mode: checkout.mode ?? "live",
    // Send exactly `amountKobo` (the price plus a few kobo, so we can tell this transfer apart). null on a
    // pending checkout whose hold has ended: the payer starts again.
    priceKobo: checkout.priceKobo,
    amountKobo: checkout.status === "pending" && !payable ? null : checkout.amountKobo,
    currency: "NGN",
    payTo:
      waiting && test
        ? testPayTo(business)
        : account
          ? { accountNumber: account.accountNumber, accountName: account.accountName ?? null, bankName: account.bankName ?? null }
          : null,
    expiresAt: checkout.expiresAt,
    // What arrived. On a donation link any amount is a whole gift ("paid"), so it can be less than the price.
    paidKobo: checkout.paidKobo ?? null,
    paidAt: checkout.paidAt ?? null,
    // Paid after the link's payment limit was reached: still "paid" (the money arrived), but a business with
    // limited stock shouldn't fulfil it without deciding to.
    overLimit: !!checkout.overLimit,
    payer: { name: checkout.payer!.name, email: checkout.payer!.email },
    // How it was started, and what the business's website attached (its server checks these when confirming).
    source: checkout.source ?? "page",
    clientReference: checkout.clientReference ?? null,
    metadata: checkout.metadata ? Object.fromEntries(checkout.metadata) : {},
    link: { slug: link.slug, title: link.title, kind: link.kind ?? "payment", image: cover ? describePublicImage(link.slug, cover) : null },
    // Donation links: how the donation will show on the page.
    donor: link.kind === "donation" ? { anonymous: !!checkout.donor?.anonymous, message: checkout.donor?.message ?? null } : null,
    business: describeBusiness(business, link),
    successMessage: received && !takenDown ? (link.successMessage ?? null) : null,
    redirectUrl,
  };
}

// ---------------------------------------------------------------------------------------------------------

/** Raised so far, the goal, quick picks and the first page of donors: everything a fundraiser page shows. */
async function describeDonation(link: PaymentLinkDocument) {
  if (link.kind !== "donation") return null;
  const first = await listPublicDonations(link, { sort: "recent", take: 20 });
  return { ...(await publicDonationProgress(link)), suggestedAmountsKobo: link.suggestedAmountsKobo ?? [], recent: first };
}

/**
 * What the payer sees at WEB_URL/pay/:slug. No internal ids or team members; totals only for donation
 * links, whose page shows what's been raised. A taken-down link shows only its title and why it's unavailable.
 */
export const getPublicPaymentLink: RequestHandler<SlugParams> = async (req, res) => {
  const { link, business } = await findPublicLink(req.params.slug);
  res.setHeader("Cache-Control", "private, no-store");
  if (isTakenDown(link)) {
    res.json({
      business: describeBusiness(business, link),
      link: {
        slug: link.slug,
        kind: link.kind ?? "payment",
        title: link.title,
        description: null,
        amountKobo: null,
        minAmountKobo: null,
        maxAmountKobo: null,
        currency: "NGN",
        phone: "off",
        customFields: [],
        images: [],
      },
      // Still the link's own, so the page keeps its frame-ancestors.
      embed: { allowedOrigins: link.allowedOrigins ?? [] },
      mode: link.mode ?? "live",
      donation: null,
      available: false,
      unavailableReason: "taken_down",
    });
    return;
  }
  const [reason, pictures, donation] = await Promise.all([unavailableReason(link), linkImages(link), describeDonation(link)]);
  res.json({
    business: describeBusiness(business, link),
    link: {
      slug: link.slug,
      kind: link.kind ?? "payment",
      title: link.title,
      description: link.description ?? null,
      // Fixed price, or null with the range the payer can type in.
      amountKobo: link.amountKobo ?? null,
      minAmountKobo: link.amountKobo ? null : (link.minAmountKobo ?? PAYMENT_LINK_LIMITS.minAmountKobo),
      maxAmountKobo: link.amountKobo ? null : PAYMENT_LINK_LIMITS.maxAmountKobo,
      currency: "NGN",
      phone: link.phone,
      customFields: link.customFields.map((f) => ({ _id: String(f._id), label: f.label, required: f.required })),
      // In order; the first is the cover. URLs are relative to the API (the web proxies /pay/<slug>/images/<id>).
      images: pictures.map((p) => describePublicImage(link.slug, p)),
    },
    // The web sets the page's `frame-ancestors` from this: [] = any site may embed it.
    embed: { allowedOrigins: link.allowedOrigins ?? [] },
    // "test": the page says so, shows placeholder bank details and lets the payer simulate the transfer.
    mode: link.mode ?? "live",
    donation,
    available: !reason,
    unavailableReason: reason,
  });
};

/**
 * A donation link's donors, for the page's list and its live updates: `?sort=recent|top&before=&take=`.
 * Anonymous donors show without a name; staff-hidden donations and test payments never show.
 * `progress` comes with every page so the page's bar can follow along.
 */
export const getPublicDonations: RequestHandler<SlugParams> = async (req, res) => {
  const query = z
    .object({
      sort: z.enum(DONATION_SORTS).default("recent"),
      before: z.string().max(80).optional(),
      take: z.coerce.number().int().min(1).max(DONATION_LIMITS.maxDonorsPage).default(20),
    })
    .parse(req.query);
  const { link } = await findPublicLink(req.params.slug);
  if (link.kind !== "donation") throw new HttpError(404, "This link doesn't take donations", "NOT_A_DONATION_LINK");
  // Its donors' names and words are no longer published either.
  if (isTakenDown(link)) throw new HttpError(404, "This fundraiser is no longer available", "PAYMENT_LINK_TAKEN_DOWN");
  const page = await listPublicDonations(link, query);
  res.setHeader("Cache-Control", "private, no-store").json({ ...page, progress: await publicDonationProgress(link) });
};

/**
 * Live updates for the link's page (Server-Sent Events): `ready`, then `link` when the link changes and `paid`
 * when a payment lands. No payer data travels on it; the page re-fetches through the routes above.
 */
export const streamPublicLinkEvents: RequestHandler<SlugParams> = async (req, res) => {
  const { link } = await findPublicLink(req.params.slug);
  serveLinkStream(req, res, link._id);
};

/**
 * Anyone can tell LinkPay a link looks wrong: `{ reason, details?, donationId?, name?, email? }`. Goes to the
 * compliance team in admin/; the business never sees it. 201 `{ received: true }`.
 */
export const reportPublicLink: RequestHandler<SlugParams> = async (req, res) => {
  const body = z
    .object({
      reason: z.enum(LINK_REPORT_REASON_KEYS),
      details: z.string().trim().max(LINK_REPORT_LIMITS.maxDetailsLength).optional(),
      donationId: z.string().max(40).optional(),
      name: z.string().trim().max(100).optional(),
      email: z.email("Enter a valid email address").max(200).optional().or(z.literal("")),
    })
    .refine((b) => b.reason !== "other" || (b.details?.length ?? 0) >= 10, {
      path: ["details"],
      message: "Tell us a little about what's wrong",
    })
    .parse(req.body);
  const { link } = await findPublicLink(req.params.slug);
  await reportLink(link, {
    reason: body.reason,
    details: body.details,
    donationId: body.donationId,
    reporter: { name: body.name, email: body.email || undefined, ip: req.ip },
  });
  res.status(201).json({ received: true });
};

const clientReference = z
  .string()
  .trim()
  .min(1)
  .max(EMBED_LIMITS.maxClientReferenceLength)
  .regex(/^[\w .:/#-]+$/, "Use letters, numbers, spaces and . : / # - _ only");
const metadata = z
  .record(
    z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,39}$/, "Keys are up to 40 letters, numbers, - or _, starting with a letter"),
    z.union([z.string().max(EMBED_LIMITS.maxMetadataValueLength), z.number(), z.boolean()]).transform(String),
  )
  .refine((m) => Object.keys(m).length <= EMBED_LIMITS.maxMetadataKeys, `Up to ${EMBED_LIMITS.maxMetadataKeys} metadata keys`);

/**
 * Starts paying: `{ name, email, phone?, amountKobo? (links without a fixed amount), fields?: { [fieldId]: value } }`,
 * plus, from the business's website, `source: "embed"`, `embedOrigin` (the website's origin, which must be
 * allowed by the link), `clientReference` (its order id) and `metadata` (up to 10 short key/values).
 * 201 with the checkout (account details and exact amount); 200 when the payer's open checkout is reused.
 */
export const startPublicCheckout: RequestHandler<SlugParams> = async (req, res) => {
  const body = z
    .object({
      name: z.string().trim().min(2, "Enter your name").max(100),
      email: z.email("Enter a valid email address").max(200),
      phone: z.string().trim().max(20).regex(/^\+?[0-9 ()-]{7,20}$/, "Enter a valid phone number").optional().or(z.literal("")),
      amountKobo: z.number().int().optional(),
      fields: z.record(z.string(), z.string().trim().max(500)).optional(),
      source: z.enum(CHECKOUT_SOURCES).default("page"),
      embedOrigin: z.string().trim().max(200).optional(),
      clientReference: clientReference.optional(),
      metadata: metadata.optional(),
      // A random key the pay page keeps for this browser: only the same key gets an open checkout back.
      resumeKey: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/).optional(),
      // Donation links only: hide my name on the page, and my words of support.
      anonymous: z.boolean().optional(),
      message: z.string().trim().max(DONATION_LIMITS.maxMessageLength, `Keep your message under ${DONATION_LIMITS.maxMessageLength} characters`).optional(),
    })
    .parse(req.body);
  const { link, business } = await findPublicLink(req.params.slug);
  // The browser enforces frame-ancestors; this stops another site starting checkouts it isn't allowed to show.
  // `embedOrigin` is what the page says it's embedded in, so it's advisory: a record for the business, never
  // proof of which website a payment came from.
  let embedOrigin: string | undefined;
  if (body.source === "embed") {
    if (!originAllowed(link.allowedOrigins ?? [], body.embedOrigin)) {
      throw new HttpError(403, "This payment link can't be used on this website", "EMBED_NOT_ALLOWED");
    }
    try {
      embedOrigin = body.embedOrigin ? new URL(body.embedOrigin).origin : undefined;
    } catch {
      embedOrigin = undefined;
    }
  }
  const reason = await unavailableReason(link);
  if (reason) throw new HttpError(409, "This payment link isn't taking payments right now", "PAYMENT_LINK_UNAVAILABLE", { reason });

  let priceKobo = link.amountKobo;
  if (!priceKobo) {
    const min = link.minAmountKobo ?? PAYMENT_LINK_LIMITS.minAmountKobo;
    const max = PAYMENT_LINK_LIMITS.maxAmountKobo;
    if (!body.amountKobo || body.amountKobo < min || body.amountKobo > max) {
      throw new HttpError(400, "Enter an amount within the limits", "INVALID_AMOUNT", { minKobo: min, maxKobo: max });
    }
    priceKobo = body.amountKobo;
  }

  const phone = body.phone || undefined;
  if (link.phone === "required" && !phone) throw new HttpError(400, "Enter your phone number", "FIELD_REQUIRED", { field: "phone" });
  const fields = [];
  for (const f of link.customFields) {
    const value = body.fields?.[String(f._id)]?.trim();
    if (f.required && !value) throw new HttpError(400, `Fill in "${f.label}"`, "FIELD_REQUIRED", { field: String(f._id) });
    if (value) fields.push({ label: f.label, value });
  }

  const { checkout, reused } = await startCheckout(
    link,
    {
      name: body.name,
      email: body.email,
      phone: link.phone === "off" ? undefined : phone,
      fields,
      ...(link.kind === "donation" && { donor: { anonymous: !!body.anonymous, message: body.message || undefined } }),
    },
    priceKobo,
    {
      source: body.source,
      embedOrigin,
      clientReference: body.clientReference,
      metadata: body.metadata,
      // The payer's address (the web forwards it), for the caps on open checkouts, with IPv6 grouped by /48
      // (CHECKOUT_RULES.ipv6Subnet): coarser than the rate limits' /56, as one customer often has a whole /48.
      clientIp: req.ip ? ipKeyGenerator(req.ip, CHECKOUT_RULES.ipv6Subnet) : undefined,
      resumeKey: body.resumeKey,
    },
  );
  res.status(reused ? 200 : 201).setHeader("Cache-Control", "private, no-store").json(await describeCheckout(checkout, link, business));
};

const CHECKOUT_TOKEN = /^[A-Za-z0-9_-]{20,64}$/;
const checkoutNotFound = () => new HttpError(404, "Checkout not found", "CHECKOUT_NOT_FOUND");

/** Answers with a checkout as payers and the business's server see it, after looking for its transfer if it's still open. */
async function sendPublicCheckout(res: Response, found: CheckoutDocument | null) {
  let checkout = found;
  if (!checkout) throw checkoutNotFound();
  // Test checkouts are only ever paid by a simulated payment, so there's nothing to pull from Liquifia.
  if (checkout.status === "pending" && checkout.mode !== "test" && checkout.holdUntil > new Date()) {
    // Look for the transfer now rather than waiting for the background sync, without keeping the payer waiting long.
    await Promise.race([syncIfStale(SYNC_MAX_AGE_MS).catch(() => {}), new Promise((r) => setTimeout(r, SYNC_WAIT_MS))]);
    checkout = (await CheckoutModel.findById(checkout._id))!;
  }
  const [link, business] = await Promise.all([PaymentLinkModel.findById(checkout.link), BusinessModel.findById(checkout.business)]);
  if (!link || !business || business.compliance?.status === "banned") throw checkoutNotFound();
  res.setHeader("Cache-Control", "private, no-store").json(await describeCheckout(checkout, link, business));
}

/** The payer's checkout page polls this until the transfer is matched. */
export const getPublicCheckout: RequestHandler<TokenParams> = async (req, res) => {
  if (!CHECKOUT_TOKEN.test(req.params.token)) throw checkoutNotFound();
  await sendPublicCheckout(res, await CheckoutModel.findOne({ token: req.params.token }));
};

/**
 * For the business's server confirming a payment (audit H12): the same answer as GET checkouts/:token, but 404
 * unless the checkout was started on this link. The business puts its own slug in the URL, so a checkout from
 * someone else's link (paid cheaply, with the business's order id as its reference) never verifies.
 */
export const getPublicLinkCheckout: RequestHandler<SlugParams & TokenParams> = async (req, res) => {
  if (!SLUG.test(req.params.slug) || !CHECKOUT_TOKEN.test(req.params.token)) throw checkoutNotFound();
  const link = await PaymentLinkModel.findOne({ slug: req.params.slug }).select("_id");
  // Looked up together, so a token from another link is "not found", with nothing pulled from Liquifia for it.
  await sendPublicCheckout(res, link && (await CheckoutModel.findOne({ token: req.params.token, link: link._id })));
};

/**
 * Test mode only: the payer (usually the business trying its own page or website) pays the checkout with a
 * simulated transfer. `{ outcome: "paid" | "underpaid" }`. 409 `CHECKOUT_IS_LIVE` on a live checkout,
 * `CHECKOUT_CLEARED` once the link has gone live. No receipt email and no notification to the team: anyone can
 * start a test checkout with anyone's email and any name.
 */
export const simulatePublicCheckout: RequestHandler<TokenParams> = async (req, res) => {
  const body = z.object({ outcome: z.enum(["paid", "underpaid"]).default("paid") }).parse(req.body ?? {});
  const notFound = checkoutNotFound();
  if (!CHECKOUT_TOKEN.test(req.params.token)) throw notFound;
  const checkout = await CheckoutModel.findOne({ token: req.params.token });
  if (!checkout) throw notFound;
  const [link, business] = await Promise.all([PaymentLinkModel.findById(checkout.link), BusinessModel.findById(checkout.business)]);
  if (!link || !business || isRestricted(business) || link.takenDown?.at) throw notFound;
  const settled = await simulateCheckoutPayment(checkout, body.outcome);
  res.setHeader("Cache-Control", "private, no-store").json(await describeCheckout(settled, link, business));
};

/**
 * The business's logo next to the link's page (and in its emails); not once the link is taken down. A refusal
 * (404) is never cached, and a CDN keeps the logo only minutes (PUBLIC_LOGO_CACHE).
 */
export const getPublicPaymentLinkLogo: RequestHandler<SlugParams> = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const { link, business } = await findPublicLink(req.params.slug);
  if (isTakenDown(link)) throw new HttpError(404, "No logo", "LOGO_NOT_FOUND");
  await sendLogo(res, business, PUBLIC_LOGO_CACHE);
};

/**
 * How long a link's public picture may be kept. URLs carry ?v= and a picture never changes under its URL, so a
 * browser keeps it a week. A shared cache (a CDN in front of the web or the API) keeps it 5 minutes and then
 * asks again (Express's ETag makes that a 304 while nothing changed), so once a link is taken down, or its
 * business suspended, no cache serves its pictures for more than about 5 minutes. Not `immutable`, and no
 * stale-while-revalidate: nothing should treat a picture as fresh past that. The web's /pay/:slug/images
 * route sends the same.
 */
export const PUBLIC_LINK_IMAGE_CACHE = "public, max-age=604800, s-maxage=300";

/**
 * One of the link's pictures. Only pictures attached to this link; never the uploaded file; none once it's taken
 * down. A refusal (404) is never cached, so a picture comes back as soon as a link is restored.
 */
export const getPublicPaymentLinkImage: RequestHandler<SlugParams & { imageId: string }> = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const { link } = await findPublicLink(req.params.slug);
  const notFound = new HttpError(404, "Picture not found", "IMAGE_NOT_FOUND");
  if (!/^[a-f0-9]{24}$/.test(req.params.imageId) || isTakenDown(link)) throw notFound;
  const image = await PaymentLinkImageModel.findOne({ _id: req.params.imageId, link: link._id });
  if (!image) throw notFound;
  await sendLinkImage(res, image, PUBLIC_LINK_IMAGE_CACHE);
};
