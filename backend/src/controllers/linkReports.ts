// Staff (admin/) side of donation links: reports from the public, taking links down, hiding donations.
// Contract: docs/briefs/donations.md §5. Reads need `compliance.view`, actions `compliance.manage`.

import type { RequestHandler } from "express";
import { isValidObjectId, Types } from "mongoose";
import { z } from "zod";
import { FLAG_SEVERITIES } from "../config/compliance";
import { LINK_REPORT_REASONS, LINK_REPORT_REASON_KEYS, type LinkReportReason } from "../config/paymentLinks";
import { BusinessModel } from "../models/Business";
import { CheckoutModel, LINK_REPORT_STATUSES, LinkReportModel, PaymentLinkModel, type CheckoutDocument, type LinkReportDocument, type PaymentLinkDocument } from "../models/PaymentLink";
import { StaffModel } from "../models/Staff";
import { staffActor } from "../services/audit";
import { complianceStatusOf } from "../services/compliance";
import { donationProgress, resolveLinkReport, restoreLink, setDonationHidden, takeDownLink } from "../services/donations";
import { paymentLinkUrl, unavailableReason } from "../services/paymentLinks";
import { assertNoConflictOfInterest } from "../services/staff";
import { HttpError } from "../utils/HttpError";

type IdParams = { id: string };

const note = z.string().trim().min(1, "Add a note").max(2000);

async function staffNames(ids: (Types.ObjectId | null | undefined)[]) {
  const unique = [...new Set(ids.filter(Boolean).map(String))];
  const staff = unique.length ? await StaffModel.find({ _id: { $in: unique } }).select("name") : [];
  return new Map(staff.map((s) => [s.id as string, { _id: s.id as string, name: s.name }]));
}

function checkId(id: string) {
  if (!isValidObjectId(id)) throw new HttpError(400, "Invalid id");
}

/** Staff don't decide about a business they own or work at (take-downs, restores, reports, donations). */
async function assertMayDecide(staffId: string, businessId: Types.ObjectId) {
  const business = await BusinessModel.findById(businessId).select("owner");
  if (business) await assertNoConflictOfInterest(staffId, business);
}

async function findReport(id: string) {
  checkId(id);
  const report = await LinkReportModel.findById(id);
  if (!report) throw new HttpError(404, "Report not found", "REPORT_NOT_FOUND");
  return report;
}

async function findLink(id: string) {
  checkId(id);
  const link = await PaymentLinkModel.findById(id);
  if (!link) throw new HttpError(404, "Payment link not found", "PAYMENT_LINK_NOT_FOUND");
  return link;
}

/** A donation as staff see it: the donor's real name even when anonymous on the page. */
function describeDonation(c: CheckoutDocument) {
  return {
    _id: c.id as string,
    name: c.payer!.name,
    email: c.payer!.email,
    anonymous: !!c.donor?.anonymous,
    message: c.donor?.message ?? null,
    amountKobo: c.paidKobo ?? 0,
    paidAt: c.paidAt ?? null,
    hidden: c.hidden?.at ? { at: c.hidden.at, note: c.hidden.note ?? null } : null,
  };
}

async function describeLink(link: PaymentLinkDocument) {
  return {
    _id: link.id as string,
    title: link.title,
    description: link.description ?? null,
    kind: link.kind ?? "payment",
    slug: link.slug,
    url: paymentLinkUrl(link),
    status: link.status,
    unavailableReason: await unavailableReason(link),
    donation: link.kind === "donation" ? donationProgress(link) : null,
    paymentsCount: link.paymentsCount,
    collectedKobo: link.collectedKobo,
    takenDown: link.takenDown?.at ? { at: link.takenDown.at, note: link.takenDown.note ?? null } : null,
    createdAt: link.get("createdAt") as Date,
  };
}

async function serializeReports(reports: LinkReportDocument[]) {
  const [links, businesses, checkouts, staff, openCounts] = await Promise.all([
    PaymentLinkModel.find({ _id: { $in: reports.map((r) => r.link) } }),
    BusinessModel.find({ _id: { $in: reports.map((r) => r.business) } }).select("name status compliance.status"),
    CheckoutModel.find({ _id: { $in: reports.map((r) => r.checkout).filter(Boolean) } }),
    staffNames(reports.map((r) => r.resolution?.by)),
    LinkReportModel.aggregate<{ _id: Types.ObjectId; count: number }>([
      { $match: { link: { $in: reports.map((r) => r.link) }, status: "open" } },
      { $group: { _id: "$link", count: { $sum: 1 } } },
    ]),
  ]);
  const linkViews = new Map(await Promise.all(links.map(async (l) => [l.id as string, await describeLink(l)] as const)));
  return reports.map((r) => {
    const b = businesses.find((x) => x._id.equals(r.business));
    const c = r.checkout && checkouts.find((x) => x._id.equals(r.checkout!));
    return {
      _id: r.id as string,
      status: r.status,
      reason: r.reason,
      reasonLabel: LINK_REPORT_REASONS[r.reason as LinkReportReason],
      details: r.details ?? null,
      reporter: { name: r.reporter?.name ?? null, email: r.reporter?.email ?? null },
      link: linkViews.get(String(r.link)) ?? { _id: String(r.link), title: "Deleted link" },
      business: b ? { _id: b.id as string, name: b.name, status: b.status, compliance: complianceStatusOf(b) } : { _id: String(r.business) },
      donation: c ? describeDonation(c) : null,
      // Open reports on the same link, this one included while it's open.
      openReportsOnLink: openCounts.find((o) => o._id.equals(r.link))?.count ?? 0,
      resolution:
        r.status === "resolved"
          ? {
              outcome: r.resolution?.outcome ?? null,
              note: r.resolution?.note ?? null,
              actions: r.resolution?.actions ?? [],
              flag: r.resolution?.flag ? String(r.resolution.flag) : null,
              by: r.resolution?.by ? (staff.get(String(r.resolution.by)) ?? null) : null,
              at: r.resolution?.at ?? null,
            }
          : null,
      createdAt: r.get("createdAt") as Date,
    };
  });
}

// ---------------------------------------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------------------------------------

/** Newest first. `?status=open|resolved|all&reason=&business=&link=&before=<id>&take=` → `{ items, nextBefore }` */
export const listLinkReports: RequestHandler = async (req, res) => {
  const objectId = z.string().refine(isValidObjectId, "Invalid id");
  const query = z
    .object({
      status: z.enum([...LINK_REPORT_STATUSES, "all"]).default("open"),
      reason: z.enum(LINK_REPORT_REASON_KEYS).optional(),
      business: objectId.optional(),
      link: objectId.optional(),
      before: objectId.optional(),
      take: z.coerce.number().int().min(1).max(100).default(30),
    })
    .parse(req.query);
  const filter = {
    ...(query.status !== "all" && { status: query.status }),
    ...(query.reason && { reason: query.reason }),
    ...(query.business && { business: new Types.ObjectId(query.business) }),
    ...(query.link && { link: new Types.ObjectId(query.link) }),
    ...(query.before && { _id: { $lt: new Types.ObjectId(query.before) } }),
  };
  const rows = await LinkReportModel.find(filter).sort({ _id: -1 }).limit(query.take + 1);
  const page = rows.slice(0, query.take);
  res.json({ items: await serializeReports(page), nextBefore: rows.length > query.take ? page.at(-1)!.id : null });
};

export const getLinkReport: RequestHandler<IdParams> = async (req, res) => {
  const report = await findReport(req.params.id);
  res.json((await serializeReports([report]))[0]);
};

/**
 * `{ outcome: "dismissed" | "actioned", note, takeDownLink?, hideDonation?, flagBusiness?: { severity } }`.
 * The extras need `actioned`; `hideDonation` needs a report about a donation.
 */
export const resolveLinkReportHandler: RequestHandler<IdParams> = async (req, res) => {
  const body = z
    .object({
      outcome: z.enum(["dismissed", "actioned"]),
      note,
      takeDownLink: z.boolean().optional(),
      hideDonation: z.boolean().optional(),
      flagBusiness: z.object({ severity: z.enum(FLAG_SEVERITIES) }).optional(),
    })
    .parse(req.body);
  const report = await findReport(req.params.id);
  await assertMayDecide(req.staffId!, report.business);
  const resolved = await resolveLinkReport(await staffActor(req), report, body);
  res.json((await serializeReports([resolved]))[0]);
};

// ---------------------------------------------------------------------------------------------------------
// Links and donations
// ---------------------------------------------------------------------------------------------------------

/** One link as staff see it, with its business and how many reports are open. */
export const getAdminPaymentLink: RequestHandler<IdParams> = async (req, res) => {
  const link = await findLink(req.params.id);
  const [business, openReports, view] = await Promise.all([
    BusinessModel.findById(link.business).select("name status compliance.status"),
    LinkReportModel.countDocuments({ link: link._id, status: "open" }),
    describeLink(link),
  ]);
  res.json({
    ...view,
    business: business ? { _id: business.id as string, name: business.name, status: business.status, compliance: complianceStatusOf(business) } : null,
    openReports,
  });
};

/** Every donation on a link, hidden ones and real names included. `?hidden=true&before=<id>&take=` → `{ items, nextBefore }` */
export const listAdminDonations: RequestHandler<IdParams> = async (req, res) => {
  const query = z
    .object({
      hidden: z.enum(["true", "false"]).optional(),
      before: z.string().refine(isValidObjectId, "Invalid id").optional(),
      take: z.coerce.number().int().min(1).max(100).default(50),
    })
    .parse(req.query);
  const link = await findLink(req.params.id);
  const rows = await CheckoutModel.find({
    link: link._id,
    status: { $in: ["paid", "underpaid"] },
    mode: { $ne: "test" },
    ...(query.hidden && { "hidden.at": { $exists: query.hidden === "true" } }),
    ...(query.before && { _id: { $lt: new Types.ObjectId(query.before) } }),
  })
    .sort({ _id: -1 })
    .limit(query.take + 1);
  const page = rows.slice(0, query.take);
  res.json({ items: page.map(describeDonation), nextBefore: rows.length > query.take ? page.at(-1)!.id : null });
};

export const takeDownPaymentLink: RequestHandler<IdParams> = async (req, res) => {
  const body = z.object({ note }).parse(req.body);
  const link = await findLink(req.params.id);
  await assertMayDecide(req.staffId!, link.business);
  res.json(await describeLink(await takeDownLink(await staffActor(req), link, body.note)));
};

export const restorePaymentLink: RequestHandler<IdParams> = async (req, res) => {
  const body = z.object({ note }).parse(req.body);
  const link = await findLink(req.params.id);
  await assertMayDecide(req.staffId!, link.business);
  res.json(await describeLink(await restoreLink(await staffActor(req), link, body.note)));
};

async function findDonation(id: string) {
  checkId(id);
  const checkout = await CheckoutModel.findById(id);
  if (!checkout || checkout.status !== "paid" && checkout.status !== "underpaid") throw new HttpError(404, "Donation not found", "DONATION_NOT_FOUND");
  return checkout;
}

/** Takes a donation off the public list (it still counts towards the total). */
export const hideDonation: RequestHandler<IdParams> = async (req, res) => {
  const body = z.object({ note }).parse(req.body);
  const checkout = await findDonation(req.params.id);
  await assertMayDecide(req.staffId!, checkout.business);
  res.json(describeDonation(await setDonationHidden(await staffActor(req), checkout, true, body.note)));
};

export const showDonation: RequestHandler<IdParams> = async (req, res) => {
  const body = z.object({ note }).parse(req.body);
  const checkout = await findDonation(req.params.id);
  await assertMayDecide(req.staffId!, checkout.business);
  res.json(describeDonation(await setDonationHidden(await staffActor(req), checkout, false, body.note)));
};
