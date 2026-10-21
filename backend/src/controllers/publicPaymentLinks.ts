import type { RequestHandler } from "express";
import { z } from "zod";
import { EMBED_LIMITS, PAYMENT_LINK_LIMITS } from "../config/paymentLinks";
import { BusinessModel, type BusinessDocument } from "../models/Business";
import { CHECKOUT_SOURCES, CheckoutModel, PaymentLinkModel, type CheckoutDocument, type PaymentLinkDocument } from "../models/PaymentLink";
import { VirtualAccountModel } from "../models/VirtualAccount";
import { accentPalette } from "../services/branding";
import { checkoutStatus, originAllowed, startCheckout, unavailableReason } from "../services/paymentLinks";
import { PaymentLinkImageModel } from "../models/PaymentLink";
import { describePublicImage, linkImages, sendLinkImage } from "../services/paymentLinkImages";
import { syncIfStale } from "../services/transactions";
import { HttpError } from "../utils/HttpError";
import { sendLogo } from "./branding";

type SlugParams = { slug: string };
type TokenParams = { token: string };

// A pending checkout's page polls; each poll pulls new transfers from Liquifia at most this often.
const SYNC_MAX_AGE_MS = 30_000;
const SYNC_WAIT_MS = 2_000;

const isRestricted = (business: BusinessDocument) =>
  business.compliance?.status === "suspended" || business.compliance?.status === "banned";

/** The link behind a public address. A suspended or closed business's links are taken down. */
async function findPublicLink(slug: string) {
  const notFound = new HttpError(404, "Payment link not found", "PAYMENT_LINK_NOT_FOUND");
  if (!/^[a-z0-9-]{6,40}$/.test(slug)) throw notFound;
  const link = await PaymentLinkModel.findOne({ slug });
  const business = link && (await BusinessModel.findById(link.business));
  if (!link || !business || isRestricted(business)) throw notFound;
  return { link, business };
}

function describeBusiness(business: BusinessDocument, slug: string) {
  const logo = business.branding?.logo;
  return {
    name: business.name,
    // Relative to the API; the web proxies it at /pay/:slug/logo.
    logo: logo?.key ? { url: `/api/public/pay/${slug}/logo?v=${logo.updatedAt?.getTime() ?? 0}`, width: logo.width, height: logo.height } : null,
    palette: accentPalette(business.branding?.accentColor),
  };
}

/** The payer's view of a checkout: what to send, where, and whether it has arrived. */
async function describeCheckout(checkout: CheckoutDocument, link: PaymentLinkDocument, business: BusinessDocument) {
  const status = checkoutStatus(checkout);
  const received = status === "paid" || status === "underpaid";
  // Only while waiting for the money, and never for a business that's been suspended since.
  const account =
    checkout.status === "pending" && !isRestricted(business)
      ? await VirtualAccountModel.findById(checkout.virtualAccount).select("accountNumber accountName bankName")
      : null;
  const [cover] = await linkImages({ images: (link.images ?? []).slice(0, 1) });
  let redirectUrl: string | null = null;
  if (status === "paid" && link.redirectUrl) {
    const url = new URL(link.redirectUrl);
    url.searchParams.set("reference", checkout.reference);
    url.searchParams.set("status", "paid");
    if (checkout.clientReference) url.searchParams.set("client_reference", checkout.clientReference);
    redirectUrl = url.toString();
  }
  return {
    token: checkout.token,
    reference: checkout.reference,
    status,
    // Send exactly `amountKobo` (the price plus a few kobo, so we can tell this transfer apart).
    priceKobo: checkout.priceKobo,
    amountKobo: checkout.amountKobo,
    currency: "NGN",
    payTo: account ? { accountNumber: account.accountNumber, accountName: account.accountName ?? null, bankName: account.bankName ?? null } : null,
    expiresAt: checkout.expiresAt,
    paidKobo: checkout.paidKobo ?? null,
    paidAt: checkout.paidAt ?? null,
    payer: { name: checkout.payer!.name, email: checkout.payer!.email },
    // How it was started, and what the business's website attached (its server checks these when confirming).
    source: checkout.source ?? "page",
    clientReference: checkout.clientReference ?? null,
    metadata: checkout.metadata ? Object.fromEntries(checkout.metadata) : {},
    link: { slug: link.slug, title: link.title, image: cover ? describePublicImage(link.slug, cover) : null },
    business: describeBusiness(business, link.slug),
    successMessage: received ? (link.successMessage ?? null) : null,
    redirectUrl,
  };
}

// ---------------------------------------------------------------------------------------------------------

/** What the payer sees at WEB_URL/pay/:slug. No internal ids, team members or totals. */
export const getPublicPaymentLink: RequestHandler<SlugParams> = async (req, res) => {
  const { link, business } = await findPublicLink(req.params.slug);
  const [reason, pictures] = await Promise.all([unavailableReason(link), linkImages(link)]);
  res.setHeader("Cache-Control", "private, no-store").json({
    business: describeBusiness(business, link.slug),
    link: {
      slug: link.slug,
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
    available: !reason,
    unavailableReason: reason,
  });
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
    })
    .parse(req.body);
  const { link, business } = await findPublicLink(req.params.slug);
  // The browser enforces frame-ancestors; this stops another site starting checkouts it isn't allowed to show.
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
    { name: body.name, email: body.email, phone: link.phone === "off" ? undefined : phone, fields },
    priceKobo,
    { source: body.source, embedOrigin, clientReference: body.clientReference, metadata: body.metadata },
  );
  res.status(reused ? 200 : 201).setHeader("Cache-Control", "private, no-store").json(await describeCheckout(checkout, link, business));
};

/** The payer's checkout page polls this until the transfer is matched. */
export const getPublicCheckout: RequestHandler<TokenParams> = async (req, res) => {
  const notFound = new HttpError(404, "Checkout not found", "CHECKOUT_NOT_FOUND");
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(req.params.token)) throw notFound;
  let checkout = await CheckoutModel.findOne({ token: req.params.token });
  if (!checkout) throw notFound;
  if (checkout.status === "pending" && checkout.holdUntil > new Date()) {
    // Look for the transfer now rather than waiting for the background sync, without keeping the payer waiting long.
    await Promise.race([syncIfStale(SYNC_MAX_AGE_MS).catch(() => {}), new Promise((r) => setTimeout(r, SYNC_WAIT_MS))]);
    checkout = (await CheckoutModel.findById(checkout._id))!;
  }
  const [link, business] = await Promise.all([PaymentLinkModel.findById(checkout.link), BusinessModel.findById(checkout.business)]);
  if (!link || !business || business.compliance?.status === "banned") throw notFound;
  res.setHeader("Cache-Control", "private, no-store").json(await describeCheckout(checkout, link, business));
};

export const getPublicPaymentLinkLogo: RequestHandler<SlugParams> = async (req, res) => {
  const { business } = await findPublicLink(req.params.slug);
  await sendLogo(res, business);
};

/** One of the link's pictures. Only pictures attached to this link; never the uploaded file. */
export const getPublicPaymentLinkImage: RequestHandler<SlugParams & { imageId: string }> = async (req, res) => {
  const { link } = await findPublicLink(req.params.slug);
  const notFound = new HttpError(404, "Picture not found", "IMAGE_NOT_FOUND");
  if (!/^[a-f0-9]{24}$/.test(req.params.imageId)) throw notFound;
  const image = await PaymentLinkImageModel.findOne({ _id: req.params.imageId, link: link._id });
  if (!image) throw notFound;
  // URLs carry ?v=, so a picture never changes under the same URL.
  await sendLinkImage(res, image, "public, max-age=604800, immutable");
};
