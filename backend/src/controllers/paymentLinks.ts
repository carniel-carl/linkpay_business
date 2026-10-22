import type { Request, RequestHandler } from "express";
import { isValidObjectId, Types } from "mongoose";
import { z } from "zod";
import { env } from "../config/env";
import { DONATION_LIMITS, EMBED_LIMITS, PAYMENT_LINK_LIMITS } from "../config/paymentLinks";
import { BranchModel } from "../models/Branch";
import {
  CHECKOUT_SOURCES,
  CheckoutModel,
  PAYMENT_LINK_KINDS,
  PAYMENT_LINK_STATUSES,
  PAYMENT_MODES,
  PHONE_FIELD_MODES,
  PaymentLinkImageModel,
  PaymentLinkModel,
  type CheckoutDocument,
  type PaymentLinkDocument,
} from "../models/PaymentLink";
import { UserModel } from "../models/User";
import { progressWithTestGifts, testTotals } from "../services/donations";
import { deleteLinkImages, describeImage, resolveLinkImages, sendLinkImage, setLinkImages, uploadLinkImage } from "../services/paymentLinkImages";
import {
  checkoutStatus,
  embedSnippets,
  linkTransactionToCheckout,
  newSlug,
  normalizeOrigin,
  paymentLinkUrl,
  simulateCheckoutPayment,
  suggestCheckoutPayments,
  unavailableReason,
} from "../services/paymentLinks";
import { branchScope, canAccessBranch, hasPermission } from "../services/team";
import { publishLinkEvent } from "../services/linkStream";
import { HttpError } from "../utils/HttpError";

type IdParams = { id: string };

const objectId = z.string().refine(isValidObjectId, "Invalid id");
const amountKobo = z
  .number()
  .int()
  .min(PAYMENT_LINK_LIMITS.minAmountKobo, "The smallest amount is ₦100")
  .max(PAYMENT_LINK_LIMITS.maxAmountKobo, "The largest amount is ₦100,000,000");
const title = z.string().trim().min(1, "Give the link a title").max(80);
const description = z.string().trim().max(500);
const customFields = z
  .array(z.object({ _id: objectId.optional(), label: z.string().trim().min(1, "Give the question a label").max(60), required: z.boolean().default(false) }))
  .max(PAYMENT_LINK_LIMITS.maxCustomFields, `Up to ${PAYMENT_LINK_LIMITS.maxCustomFields} questions`);
const redirectUrl = z
  .string()
  .trim()
  .max(500)
  .refine((v) => {
    try {
      return ["https:", "http:"].includes(new URL(v).protocol);
    } catch {
      return false;
    }
  }, "Use a full web address starting with https://");
const successMessage = z.string().trim().max(300);
const maxPayments = z.number().int().min(1).max(1_000_000);
/** Uploaded picture ids, in order (the first is the cover). */
const images = z.array(z.string().max(64)).max(20);
/** Websites allowed to embed the link, normalised to origins and de-duplicated. Empty = any site. */
const allowedOrigins = z
  .array(z.string().max(200))
  .max(EMBED_LIMITS.maxAllowedOrigins, `Up to ${EMBED_LIMITS.maxAllowedOrigins} websites`)
  .transform((list, ctx) => {
    const out: string[] = [];
    list.forEach((raw, i) => {
      const origin = normalizeOrigin(raw);
      if (!origin) {
        ctx.addIssue({ code: "custom", path: [i], message: "Use a website address like https://shop.example.com (https only)" });
      } else if (!out.includes(origin)) out.push(origin);
    });
    return out;
  });

/** Donation links: the target and quick-pick amounts. */
const goalKobo = z
  .number()
  .int()
  .min(DONATION_LIMITS.minGoalKobo, "The smallest goal is ₦1,000")
  .max(DONATION_LIMITS.maxGoalKobo, "The largest goal is ₦10,000,000,000");
const suggestedAmountsKobo = z
  .array(amountKobo)
  .max(DONATION_LIMITS.maxSuggestedAmounts, `Up to ${DONATION_LIMITS.maxSuggestedAmounts} suggested amounts`)
  .transform((list) => [...new Set(list)].sort((a, b) => a - b));

function checkAmounts(fixed: number | null | undefined, min: number | null | undefined, kind = "payment") {
  if (fixed && min) throw new HttpError(400, "A fixed amount can't also have a minimum", "INVALID_AMOUNT");
  if (fixed && kind === "donation") throw new HttpError(400, "Donors choose how much to give, so a donation link can't have a fixed amount", "INVALID_AMOUNT");
}

/** A goal and suggested amounts only make sense on a donation link; suggestions must be at least the minimum. */
function checkDonation(kind: string, goal: number | null | undefined, suggested: number[] | null | undefined, min: number | null | undefined) {
  if (kind !== "donation" && (goal || suggested?.length)) {
    throw new HttpError(400, "Only donation links have a goal or suggested amounts", "NOT_A_DONATION_LINK");
  }
  if (min && suggested?.some((s) => s < min)) throw new HttpError(400, "Suggested amounts can't be below the minimum", "INVALID_AMOUNT");
}

function checkExpiry(expiresAt: Date | null | undefined) {
  if (expiresAt && expiresAt <= new Date()) throw new HttpError(400, "The end date must be in the future", "INVALID_DATES");
}

// ---------------------------------------------------------------------------------------------------------

async function serializeLinks(req: Request, links: PaymentLinkDocument[]) {
  const [users, branches, reasons, pictures, tests] = await Promise.all([
    UserModel.find({ _id: { $in: links.map((l) => l.createdBy) } }).select("name"),
    BranchModel.find({ _id: { $in: links.map((l) => l.branch) } }).select("name isHeadOffice"),
    Promise.all(links.map((l) => unavailableReason(l))),
    PaymentLinkImageModel.find({ _id: { $in: links.flatMap((l) => l.images ?? []) } }),
    testTotals(links.filter((l) => l.mode === "test").map((l) => l._id)),
  ]);
  const canManage = hasPermission(req.membership!, "payments.manage");
  return links.map((l, i) => {
    const t = tests.get(l.id);
    const u = users.find((x) => x._id.equals(l.createdBy));
    const b = branches.find((x) => x._id.equals(l.branch));
    return {
      _id: l.id as string,
      title: l.title,
      description: l.description ?? null,
      slug: l.slug,
      url: paymentLinkUrl(l),
      branch: b ? { _id: b.id, name: b.name, isHeadOffice: b.isHeadOffice } : null,
      kind: l.kind ?? "payment",
      // null = the payer chooses the amount (at least minAmountKobo, if set).
      amountKobo: l.amountKobo ?? null,
      minAmountKobo: l.minAmountKobo ?? null,
      // Donation links: the goal, quick picks and progress (raised = collectedKobo, plus the test gifts while in
      // test mode, `testKobo` of it, as the public page shows). null on payment links.
      donation:
        l.kind === "donation" ? { ...progressWithTestGifts(l, t), suggestedAmountsKobo: l.suggestedAmountsKobo ?? [] } : null,
      // Set when LinkPay staff took the link down; it can't be turned back on until they restore it.
      takenDown: l.takenDown?.at ? { at: l.takenDown.at } : null,
      currency: "NGN",
      phone: l.phone,
      customFields: l.customFields.map((f) => ({ _id: String(f._id), label: f.label, required: f.required })),
      // In order; the first is the cover.
      images: (l.images ?? []).flatMap((id) => pictures.filter((p) => p._id.equals(id)).map(describeImage)),
      successMessage: l.successMessage ?? null,
      redirectUrl: l.redirectUrl ?? null,
      status: l.status,
      // "test": placeholder bank details and simulated payments, never counted in the totals below.
      mode: l.mode ?? "live",
      // Websites that may embed the link; [] = any site.
      allowedOrigins: l.allowedOrigins ?? [],
      expiresAt: l.expiresAt ?? null,
      maxPayments: l.maxPayments ?? null,
      paymentsCount: l.paymentsCount,
      collectedKobo: l.collectedKobo,
      lastPaidAt: l.lastPaidAt ?? null,
      // While in test mode: what the simulated payments came to, shown beside the real figures. null when live.
      test: l.mode === "test" ? { collectedKobo: t?.kobo ?? 0, paymentsCount: t?.count ?? 0 } : null,
      // Whether the public page takes new payments right now, and if not, why.
      available: !reasons[i],
      unavailableReason: reasons[i],
      createdBy: u ? { _id: u.id, name: u.name } : null,
      createdAt: l.get("createdAt"),
      updatedAt: l.get("updatedAt"),
      canManage,
    };
  });
}

async function serializeCheckouts(req: Request, checkouts: CheckoutDocument[]) {
  const [links, branches, users] = await Promise.all([
    PaymentLinkModel.find({ _id: { $in: checkouts.map((c) => c.link) } }).select("title slug"),
    BranchModel.find({ _id: { $in: checkouts.map((c) => c.branch) } }).select("name isHeadOffice"),
    UserModel.find({ _id: { $in: checkouts.map((c) => c.matchedByUser).filter(Boolean) } }).select("name"),
  ]);
  const canManage = hasPermission(req.membership!, "payments.manage");
  const now = new Date();
  return checkouts.map((c) => {
    const l = links.find((x) => x._id.equals(c.link));
    const b = branches.find((x) => x._id.equals(c.branch));
    const u = c.matchedByUser && users.find((x) => x._id.equals(c.matchedByUser!));
    const status = checkoutStatus(c, now);
    return {
      _id: c.id as string,
      reference: c.reference,
      status,
      // The link's mode when the checkout started. Test checkouts move no money and match no transfer.
      mode: c.mode ?? "live",
      link: l ? { _id: l.id, title: l.title, slug: l.slug } : null,
      branch: b ? { _id: b.id, name: b.name, isHeadOffice: b.isHeadOffice } : null,
      payer: { name: c.payer!.name, email: c.payer!.email, phone: c.payer?.phone ?? null, fields: c.payer?.fields ?? [] },
      // Donation links: whether the name is hidden on the public list, their message, and whether staff
      // took it off the list. null for payment links.
      donor: c.donor?.anonymous !== undefined || c.donor?.message ? { anonymous: !!c.donor?.anonymous, message: c.donor?.message ?? null } : null,
      hiddenFromPage: !!c.hidden?.at,
      // What they owe, and the exact amount they were asked to send (owed plus 1..99 kobo).
      priceKobo: c.priceKobo,
      amountKobo: c.amountKobo,
      currency: "NGN",
      paidKobo: c.paidKobo ?? null,
      paidAt: c.paidAt ?? null,
      // "page" or "embed" (with the website it was on), and what the website attached.
      source: c.source ?? "page",
      embedOrigin: c.embedOrigin ?? null,
      clientReference: c.clientReference ?? null,
      metadata: c.metadata ? Object.fromEntries(c.metadata) : {},
      matchedBy: c.matchedBy ?? null,
      matchedByUser: u ? { _id: u.id, name: u.name } : null,
      transaction: c.transaction ? String(c.transaction) : null,
      expiresAt: c.expiresAt,
      createdAt: c.get("createdAt"),
      // A pending or expired checkout can be linked by hand to a payment the matcher missed.
      canMatch: canManage && c.status === "pending" && c.mode !== "test",
      // A test checkout is paid by simulating the transfer instead.
      canSimulate: canManage && c.status === "pending" && c.mode === "test",
    };
  });
}

async function findLink(req: Request, id: string) {
  if (!isValidObjectId(id)) throw new HttpError(400, "Invalid id");
  const link = await PaymentLinkModel.findOne({ _id: id, business: req.business!._id });
  if (!link || !canAccessBranch(req.membership!, link.branch)) throw new HttpError(404, "Payment link not found", "PAYMENT_LINK_NOT_FOUND");
  return link;
}

async function findCheckout(req: Request, id: string) {
  if (!isValidObjectId(id)) throw new HttpError(400, "Invalid id");
  const checkout = await CheckoutModel.findOne({ _id: id, business: req.business!._id });
  if (!checkout || !canAccessBranch(req.membership!, checkout.branch)) throw new HttpError(404, "Checkout not found", "CHECKOUT_NOT_FOUND");
  return checkout;
}

/** Mongo filter on `branch` for an optional ?branch= and the member's branch scope. */
function branchFilter(req: Request, branch?: string) {
  if (branch && !canAccessBranch(req.membership!, branch)) throw new HttpError(404, "Branch not found");
  const scope = branchScope(req.membership!);
  return branch ? { branch: new Types.ObjectId(branch) } : scope ? { branch: { $in: scope } } : {};
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const paging = { skip: z.coerce.number().int().min(0).default(0), take: z.coerce.number().int().min(1).max(100).default(20) };

// ---------------------------------------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------------------------------------

/** Newest first. `?status=active|inactive|all&kind=payment|donation&branch=&q=&skip=&take=` */
/** Mongo filter for `?mode=live|test|all`. Links and checkouts from before test mode have no mode: live. */
const modeFilter = (mode: "live" | "test" | "all") => (mode === "all" ? {} : { mode: mode === "test" ? "test" : { $ne: "test" } });

export const listPaymentLinks: RequestHandler = async (req, res) => {
  const query = z
    .object({
      status: z.enum([...PAYMENT_LINK_STATUSES, "all"]).default("all"),
      kind: z.enum(PAYMENT_LINK_KINDS).optional(),
      mode: z.enum([...PAYMENT_MODES, "all"]).default("all"),
      branch: objectId.optional(),
      q: z.string().trim().max(100).optional(),
      ...paging,
    })
    .parse(req.query);
  const filter: Record<string, unknown> = {
    business: req.business!._id,
    ...branchFilter(req, query.branch),
    ...(query.status !== "all" && { status: query.status }),
    ...modeFilter(query.mode),
    // Links from before donations have no kind: they're payment links.
    ...(query.kind && (query.kind === "payment" ? { kind: { $ne: "donation" } } : { kind: "donation" })),
    ...(query.q && { title: new RegExp(escapeRegex(query.q), "i") }),
  };
  const [links, total] = await Promise.all([
    PaymentLinkModel.find(filter).sort({ createdAt: -1 }).skip(query.skip).limit(query.take),
    PaymentLinkModel.countDocuments(filter),
  ]);
  res.json({ items: await serializeLinks(req, links), total, skip: query.skip, take: query.take });
};

/**
 * Totals for the member's branches (or one branch): links by status, and money collected all time and in the
 * last 30 days. Test payments are never counted in those; `test` is what links in test mode have simulated.
 */
export const getPaymentLinksSummary: RequestHandler = async (req, res) => {
  const query = z.object({ branch: objectId.optional() }).parse(req.query);
  const base = { business: req.business!._id, ...branchFilter(req, query.branch) };
  const since = new Date(Date.now() - 30 * 86_400_000);
  const [byStatus, allTime, recent] = await Promise.all([
    PaymentLinkModel.aggregate([{ $match: base }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
    PaymentLinkModel.aggregate([{ $match: base }, { $group: { _id: null, kobo: { $sum: "$collectedKobo" }, count: { $sum: "$paymentsCount" } } }]),
    CheckoutModel.aggregate([
      { $match: { ...base, status: { $in: ["paid", "underpaid"] }, mode: { $ne: "test" }, paidAt: { $gte: since } } },
      { $group: { _id: null, kobo: { $sum: "$paidKobo" }, count: { $sum: 1 } } },
    ]),
  ]);
  const count = (status: string) => byStatus.find((s) => s._id === status)?.count ?? 0;
  const testLinks = await PaymentLinkModel.find({ ...base, mode: "test" }).select("_id");
  const tests = [...(await testTotals(testLinks.map((l) => l._id))).values()];
  res.json({
    links: { active: count("active"), inactive: count("inactive") },
    collectedKobo: allTime[0]?.kobo ?? 0,
    paymentsCount: allTime[0]?.count ?? 0,
    last30Days: { collectedKobo: recent[0]?.kobo ?? 0, paymentsCount: recent[0]?.count ?? 0 },
    test: { collectedKobo: tests.reduce((n, t) => n + t.kobo, 0), paymentsCount: tests.reduce((n, t) => n + t.count, 0) },
    currency: "NGN",
  });
};

export const getPaymentLink: RequestHandler<IdParams> = async (req, res) => {
  res.json((await serializeLinks(req, [await findLink(req, req.params.id)]))[0]);
};

/** Code to paste into the business's website: pay button (popup), inline page, and the JavaScript call. */
export const getPaymentLinkEmbed: RequestHandler<IdParams> = async (req, res) => {
  const link = await findLink(req, req.params.id);
  res.json({
    ...embedSnippets(link),
    allowedOrigins: link.allowedOrigins ?? [],
    // In test mode the code works the same, but payments are simulated; the verify call returns `mode: "test"`.
    mode: link.mode ?? "live",
    // Where the business's server confirms a checkout before fulfilling the order (no sign-in; the token is the secret).
    verifyUrl: `${env.apiPublicUrl}/api/public/checkouts/{token}`,
  });
};

export const createPaymentLink: RequestHandler = async (req, res) => {
  const body = z
    .object({
      branch: objectId,
      kind: z.enum(PAYMENT_LINK_KINDS).default("payment"),
      title,
      description: description.optional(),
      amountKobo: amountKobo.nullable().optional(),
      minAmountKobo: amountKobo.nullable().optional(),
      goalKobo: goalKobo.nullable().optional(),
      suggestedAmountsKobo: suggestedAmountsKobo.optional(),
      phone: z.enum(PHONE_FIELD_MODES).optional(),
      customFields: customFields.optional(),
      successMessage: successMessage.optional(),
      redirectUrl: redirectUrl.optional(),
      allowedOrigins: allowedOrigins.optional(),
      images: images.nullable().optional(),
      expiresAt: z.coerce.date().nullable().optional(),
      maxPayments: maxPayments.nullable().optional(),
      mode: z.enum(PAYMENT_MODES).optional(),
    })
    .parse(req.body);
  checkAmounts(body.amountKobo, body.minAmountKobo, body.kind);
  checkDonation(body.kind, body.goalKobo, body.suggestedAmountsKobo, body.minAmountKobo);
  const pictures = body.images?.length ? await resolveLinkImages(req.business!._id, body.images) : [];
  checkExpiry(body.expiresAt);
  if (!canAccessBranch(req.membership!, body.branch)) throw new HttpError(404, "Branch not found");
  const branch = await BranchModel.findOne({ _id: body.branch, business: req.business!._id });
  if (!branch) throw new HttpError(404, "Branch not found");
  if ((await PaymentLinkModel.countDocuments({ business: req.business!._id })) >= PAYMENT_LINK_LIMITS.maxLinks) {
    throw new HttpError(409, `A business can have up to ${PAYMENT_LINK_LIMITS.maxLinks} payment links. Delete some you no longer use.`, "PAYMENT_LINK_LIMIT");
  }

  for (let attempt = 0; ; attempt++) {
    try {
      const link = await PaymentLinkModel.create({
        business: req.business!._id,
        branch: branch._id,
        kind: body.kind,
        title: body.title,
        description: body.description || undefined,
        slug: newSlug(),
        amountKobo: body.amountKobo ?? undefined,
        minAmountKobo: body.minAmountKobo ?? undefined,
        goalKobo: body.goalKobo ?? undefined,
        suggestedAmountsKobo: body.suggestedAmountsKobo?.length ? body.suggestedAmountsKobo : undefined,
        phone: body.phone,
        customFields: (body.customFields ?? []).map(({ label, required }) => ({ label, required })),
        successMessage: body.successMessage || undefined,
        redirectUrl: body.redirectUrl || undefined,
        allowedOrigins: body.allowedOrigins ?? [],
        expiresAt: body.expiresAt ?? undefined,
        maxPayments: body.maxPayments ?? undefined,
        mode: body.mode ?? "live",
        createdBy: req.userId,
      });
      if (pictures.length) await setLinkImages(link, pictures);
      res.status(201).json((await serializeLinks(req, [link]))[0]);
      return;
    } catch (err: any) {
      // A slug clash (very unlikely): try a new one.
      if (err?.code === 11000 && err.keyPattern?.slug && attempt < 3) continue;
      throw err;
    }
  }
};

/**
 * Edits the link. Changes apply to new checkouts only; anyone already paying keeps their amount.
 * `null` clears the description, fixed amount (payer chooses), minimum, message, redirect, end date, limit or
 * allowed websites (any site may embed it again).
 * `customFields` replaces the list; send `_id` to keep a question's id.
 */
export const updatePaymentLink: RequestHandler<IdParams> = async (req, res) => {
  const body = z
    .object({
      title: title.optional(),
      description: description.nullable().optional(),
      amountKobo: amountKobo.nullable().optional(),
      minAmountKobo: amountKobo.nullable().optional(),
      goalKobo: goalKobo.nullable().optional(),
      suggestedAmountsKobo: suggestedAmountsKobo.nullable().optional(),
      phone: z.enum(PHONE_FIELD_MODES).optional(),
      customFields: customFields.optional(),
      successMessage: successMessage.nullable().optional(),
      redirectUrl: redirectUrl.nullable().optional(),
      allowedOrigins: allowedOrigins.nullable().optional(),
      images: images.nullable().optional(),
      status: z.enum(PAYMENT_LINK_STATUSES).optional(),
      // Either way, at any time. Checkouts already started keep their own mode.
      mode: z.enum(PAYMENT_MODES).optional(),
      expiresAt: z.coerce.date().nullable().optional(),
      maxPayments: maxPayments.nullable().optional(),
    })
    .strict()
    .parse(req.body);
  const link = await findLink(req, req.params.id);
  const pictures = body.images?.length ? await resolveLinkImages(req.business!._id, body.images, link._id) : [];

  const fixed = body.amountKobo !== undefined ? body.amountKobo : link.amountKobo;
  // Setting a fixed amount drops the minimum, unless one is sent with it (which is an error).
  const min = body.minAmountKobo !== undefined ? body.minAmountKobo : body.amountKobo ? null : link.minAmountKobo;
  const kind = link.kind ?? "payment";
  checkAmounts(fixed, min, kind);
  const suggested = body.suggestedAmountsKobo !== undefined ? body.suggestedAmountsKobo : link.suggestedAmountsKobo;
  checkDonation(kind, body.goalKobo, suggested, min);
  if (body.expiresAt !== undefined && body.expiresAt?.getTime() !== link.expiresAt?.getTime()) checkExpiry(body.expiresAt);
  // Only LinkPay staff can bring back a link they took down.
  if (body.status === "active" && link.takenDown?.at) {
    throw new HttpError(409, "LinkPay has paused this link while we review it. Contact support to turn it back on.", "PAYMENT_LINK_TAKEN_DOWN");
  }

  if (body.suggestedAmountsKobo !== undefined) link.set("suggestedAmountsKobo", body.suggestedAmountsKobo?.length ? body.suggestedAmountsKobo : undefined);
  const clearable = ["description", "successMessage", "redirectUrl", "expiresAt", "maxPayments", "goalKobo"] as const;
  for (const key of clearable) if (body[key] !== undefined) link.set(key, body[key] || undefined);
  if (body.title) link.title = body.title;
  if (body.phone) link.phone = body.phone;
  if (body.status) link.status = body.status;
  // Going live clears the test payments: they leave the test table, the totals and the public page.
  const goingLive = body.mode === "live" && link.mode === "test";
  if (body.mode) link.mode = body.mode;
  if (goingLive) await CheckoutModel.updateMany({ link: link._id, mode: "test", testClearedAt: { $exists: false } }, { testClearedAt: new Date() });
  if (body.allowedOrigins !== undefined) link.set("allowedOrigins", body.allowedOrigins ?? []);
  link.set("amountKobo", fixed ?? undefined);
  link.set("minAmountKobo", min ?? undefined);
  if (body.customFields) {
    link.set(
      "customFields",
      body.customFields.map((f) => ({ ...(f._id && link.customFields.some((c) => String(c._id) === f._id) && { _id: f._id }), label: f.label, required: f.required })),
    );
  }
  await link.save();
  // The list replaces the saved one; pictures left out are deleted. null or [] clears.
  if (body.images !== undefined) await setLinkImages(link, pictures);
  // Open pages reload: live or test, on or off, the details and pictures.
  publishLinkEvent(link._id, "link");
  res.json((await serializeLinks(req, [link]))[0]);
};

/** Only a link nobody has started paying through (test payments don't count); otherwise turn it off (`status: "inactive"`). */
export const deletePaymentLink: RequestHandler<IdParams> = async (req, res) => {
  const link = await findLink(req, req.params.id);
  if (await CheckoutModel.exists({ link: link._id, mode: { $ne: "test" } })) {
    throw new HttpError(409, "People have already paid or started paying through this link. Turn it off instead.", "PAYMENT_LINK_IN_USE");
  }
  // Test checkouts moved no money, so they go with the link.
  await CheckoutModel.deleteMany({ link: link._id, mode: "test" });
  await link.deleteOne();
  await deleteLinkImages(link._id);
  publishLinkEvent(link._id, "link");
  res.status(204).end();
};

// ---------------------------------------------------------------------------------------------------------
// Pictures
// ---------------------------------------------------------------------------------------------------------

/**
 * Multipart `file` (PNG, JPG or WebP, 5 MB). Uploaded before the link is saved; send the id in `images` on
 * create or edit. Stored as a WebP we made (upright, no metadata, at most 1600px); unused ones go after 24h.
 */
export const uploadPaymentLinkImage: RequestHandler = async (req, res) => {
  if (!req.file) throw new HttpError(400, "Attach the picture in a 'file' form field", "FILE_REQUIRED");
  const image = await uploadLinkImage(req.business!._id, req.userId!, req.file.buffer);
  res.status(201).json(describeImage(image));
};

/** A picture for the dashboard: this business's, and on a link in the member's branches (or not attached yet). */
export const getPaymentLinkImage: RequestHandler<IdParams> = async (req, res) => {
  const notFound = new HttpError(404, "Picture not found", "IMAGE_NOT_FOUND");
  if (!isValidObjectId(req.params.id)) throw notFound;
  const image = await PaymentLinkImageModel.findOne({ _id: req.params.id, business: req.business!._id });
  if (!image) throw notFound;
  if (image.link) {
    const link = await PaymentLinkModel.findById(image.link).select("branch");
    if (!link || !canAccessBranch(req.membership!, link.branch)) throw notFound;
  }
  await sendLinkImage(res, image, "private, max-age=3600");
};

// ---------------------------------------------------------------------------------------------------------
// Checkouts (payments through links)
// ---------------------------------------------------------------------------------------------------------

const CHECKOUT_FILTERS = ["pending", "expired", "paid", "underpaid", "received", "all"] as const;

/**
 * Newest first. `?link=&branch=&status=&source=page|embed&mode=live|test|all&q=&skip=&take=` (`q`: payer, our reference or the
 * business's own order reference). `status=received` is paid and underpaid together;
 * `pending` is still within its time, `expired` is past it with nothing matched yet.
 */
export const listCheckouts: RequestHandler = async (req, res) => {
  const query = z
    .object({
      link: objectId.optional(),
      branch: objectId.optional(),
      status: z.enum(CHECKOUT_FILTERS).default("all"),
      source: z.enum(CHECKOUT_SOURCES).optional(),
      mode: z.enum([...PAYMENT_MODES, "all"]).default("all"),
      q: z.string().trim().max(100).optional(),
      ...paging,
    })
    .parse(req.query);
  if (query.link) await findLink(req, query.link);
  const now = new Date();
  const status = {
    pending: { status: "pending", expiresAt: { $gt: now } },
    expired: { status: "pending", expiresAt: { $lte: now } },
    paid: { status: "paid" },
    underpaid: { status: "underpaid" },
    received: { status: { $in: ["paid", "underpaid"] } },
    all: {},
  }[query.status];
  const re = query.q && new RegExp(escapeRegex(query.q), "i");
  const filter: Record<string, unknown> = {
    business: req.business!._id,
    ...branchFilter(req, query.branch),
    ...(query.link && { link: new Types.ObjectId(query.link) }),
    ...status,
    // Checkouts from before embedding have no source: they came from the page.
    ...(query.source && (query.source === "page" ? { source: { $ne: "embed" } } : { source: "embed" })),
    ...modeFilter(query.mode),
    // Test payments cleared when their link went live are gone from the lists.
    testClearedAt: { $exists: false },
    ...(re && { $or: [{ "payer.name": re }, { "payer.email": re }, { reference: re }, { clientReference: re }] }),
  };
  const [items, total] = await Promise.all([
    CheckoutModel.find(filter).sort({ createdAt: -1 }).skip(query.skip).limit(query.take),
    CheckoutModel.countDocuments(filter),
  ]);
  res.json({ items: await serializeCheckouts(req, items), total, skip: query.skip, take: query.take });
};

export const getCheckout: RequestHandler<IdParams> = async (req, res) => {
  res.json((await serializeCheckouts(req, [await findCheckout(req, req.params.id)]))[0]);
};

/**
 * Incoming payments on the same account that look like they're for this checkout, for linking by hand.
 * Same shape as the invoice suggestions: `{ items: [{ _id, amountKobo, counterparty, narration, reference, occurredAt, exactAmount }] }`.
 */
export const getCheckoutSuggestions: RequestHandler<IdParams> = async (req, res) => {
  const checkout = await findCheckout(req, req.params.id);
  const items = checkout.status === "pending" ? await suggestCheckoutPayments(checkout) : [];
  res.json({
    items: items.map((tx) => ({
      _id: tx.id as string,
      amountKobo: tx.amountKobo,
      counterparty: { name: tx.counterparty?.name ?? null, bankName: tx.counterparty?.bankName ?? null },
      narration: tx.narration ?? null,
      reference: tx.reference ?? null,
      occurredAt: tx.occurredAt,
      // The price, or the exact amount the payer was asked to send.
      exactAmount: tx.amountKobo === checkout.priceKobo || tx.amountKobo === checkout.amountKobo,
    })),
  });
};

/** Links an incoming transfer to the checkout, which marks it paid (or underpaid) and sends the receipt. */
export const matchCheckout: RequestHandler<IdParams> = async (req, res) => {
  const body = z.object({ transactionId: objectId }).parse(req.body);
  const checkout = await findCheckout(req, req.params.id);
  const settled = await linkTransactionToCheckout(checkout, body.transactionId, req.userId!);
  res.json((await serializeCheckouts(req, [settled]))[0]);
};

/**
 * Test mode: pays a test checkout as if the transfer had arrived. `{ outcome: "paid" | "underpaid" }` (underpaid
 * = half the price). Sends the notification and a receipt marked as a test; no money moves.
 */
export const simulateCheckout: RequestHandler<IdParams> = async (req, res) => {
  const body = z.object({ outcome: z.enum(["paid", "underpaid"]).default("paid") }).parse(req.body ?? {});
  const checkout = await findCheckout(req, req.params.id);
  const settled = await simulateCheckoutPayment(checkout, body.outcome, req.userId!);
  res.json((await serializeCheckouts(req, [settled]))[0]);
};
