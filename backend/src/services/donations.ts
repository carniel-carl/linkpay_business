// Donation links (fundraisers): the public donor list, reports from the public, and what staff can do about
// them. Contract: docs/briefs/donations.md. Payments themselves go through the ordinary checkout flow
// (services/paymentLinks.ts).

import { Types } from "mongoose";
import { DONATION_LIMITS, LINK_REPORT_REASONS, type LinkReportReason } from "../config/paymentLinks";
import { BusinessModel } from "../models/Business";
import {
  CheckoutModel,
  LinkReportModel,
  PaymentLinkModel,
  type CheckoutDocument,
  type LinkReportDocument,
  type PaymentLinkDocument,
} from "../models/PaymentLink";
import { HttpError } from "../utils/HttpError";
import { audit, type Actor } from "./audit";
import { raiseFlag } from "./compliance";
import { linkReported, paymentLinkModerated } from "./notificationEvents";

type StaffActor = Actor & { type: "staff" };

// ---------------------------------------------------------------------------------------------------------
// The public donor list
// ---------------------------------------------------------------------------------------------------------

export const DONATION_SORTS = ["recent", "top"] as const;
export type DonationSort = (typeof DONATION_SORTS)[number];

/** Real donations that arrived and that staff haven't hidden (test-mode payments never show). */
const shownDonations = (linkId: Types.ObjectId): Record<string, unknown> => ({
  link: linkId,
  status: { $in: ["paid", "underpaid"] },
  mode: { $ne: "test" },
  "hidden.at": { $exists: false },
});

/** "<sort value>_<id>": the last row of a page, so the next page starts after it. */
const encodeCursor = (value: number, id: Types.ObjectId) => `${value}_${id}`;
function decodeCursor(cursor: string) {
  const [value, id] = cursor.split("_");
  if (!value || !/^\d+$/.test(value) || !id || !Types.ObjectId.isValid(id)) throw new HttpError(400, "Invalid cursor");
  return { value: Number(value), id: new Types.ObjectId(id) };
}

/** What anyone can see of one donation: never the email, and no name when the donor asked to stay anonymous. */
export function describePublicDonation(c: CheckoutDocument) {
  const anonymous = !!c.donor?.anonymous;
  return {
    _id: c.id as string,
    name: anonymous ? null : c.payer!.name,
    anonymous,
    amountKobo: c.paidKobo ?? 0,
    message: c.donor?.message ?? null,
    paidAt: c.paidAt ?? null,
  };
}

/**
 * One page of a donation link's donors, newest (`recent`) or largest (`top`) first.
 * `before` is the `nextBefore` of the previous page.
 */
export async function listPublicDonations(link: PaymentLinkDocument, opts: { sort: DonationSort; before?: string; take: number }) {
  const field = opts.sort === "top" ? "paidKobo" : "paidAt";
  const filter: Record<string, unknown> = shownDonations(link._id);
  if (opts.before) {
    const { value, id } = decodeCursor(opts.before);
    const v = field === "paidAt" ? new Date(value) : value;
    filter.$or = [{ [field]: { $lt: v } }, { [field]: v, _id: { $lt: id } }];
  }
  const take = Math.min(opts.take, DONATION_LIMITS.maxDonorsPage);
  const rows = await CheckoutModel.find(filter)
    .sort({ [field]: -1, _id: -1 })
    .limit(take + 1);
  const page = rows.slice(0, take);
  const last = page.at(-1);
  const lastValue = last && (field === "paidAt" ? (last.paidAt?.getTime() ?? 0) : (last.paidKobo ?? 0));
  return {
    items: page.map(describePublicDonation),
    nextBefore: rows.length > take && last ? encodeCursor(lastValue!, last._id) : null,
  };
}

/** The fundraiser's figures: what's been raised towards the goal, by how many donations. */
export function donationProgress(link: PaymentLinkDocument) {
  const goalKobo = link.goalKobo ?? null;
  return {
    goalKobo,
    raisedKobo: link.collectedKobo,
    donationsCount: link.paymentsCount,
    // 0 to 100+ (a goal can be passed); null without a goal.
    percent: goalKobo ? Math.floor((link.collectedKobo / goalKobo) * 100) : null,
    lastDonationAt: link.lastPaidAt ?? null,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Reports from the public
// ---------------------------------------------------------------------------------------------------------

export type NewLinkReport = {
  reason: LinkReportReason;
  details?: string;
  donationId?: string;
  reporter: { name?: string; email?: string; ip?: string };
};

/** Saves a report about a link (or one donation on its list) and tells the compliance team. */
export async function reportLink(link: PaymentLinkDocument, input: NewLinkReport) {
  let checkout: CheckoutDocument | null = null;
  if (input.donationId) {
    checkout = Types.ObjectId.isValid(input.donationId)
      ? await CheckoutModel.findOne({ _id: input.donationId, ...shownDonations(link._id) })
      : null;
    if (!checkout) throw new HttpError(404, "That donation isn't on this page", "DONATION_NOT_FOUND");
  }
  const report = await LinkReportModel.create({
    business: link.business,
    link: link._id,
    checkout: checkout?._id,
    reason: input.reason,
    details: input.details || undefined,
    reporter: {
      name: input.reporter.name || undefined,
      email: input.reporter.email || undefined,
      ip: input.reporter.ip,
    },
  });
  const business = await BusinessModel.findById(link.business).select("name");
  const openOnLink = await LinkReportModel.countDocuments({ link: link._id, status: "open" });
  if (business) await linkReported(business, link, report, { openOnLink, aboutDonation: !!checkout });
  return report;
}

// ---------------------------------------------------------------------------------------------------------
// Staff moderation
// ---------------------------------------------------------------------------------------------------------

/** Stops the link taking payments; the business can't turn it back on. No-op when it's already down. */
export async function takeDownLink(actor: StaffActor, link: PaymentLinkDocument, note: string) {
  if (link.takenDown?.at) return link;
  link.set("takenDown", { at: new Date(), by: actor.staff, note });
  await link.save();
  await audit(actor, {
    action: "payment_link.taken_down",
    business: link.business,
    target: { kind: "payment_link", id: link._id },
    summary: `Took down "${link.title}"`,
    details: { note },
  });
  const business = await BusinessModel.findById(link.business);
  if (business) await paymentLinkModerated(business, link, "taken_down");
  return link;
}

export async function restoreLink(actor: StaffActor, link: PaymentLinkDocument, note: string) {
  if (!link.takenDown?.at) throw new HttpError(409, "This link isn't taken down", "PAYMENT_LINK_NOT_TAKEN_DOWN");
  link.set("takenDown", undefined);
  await link.save();
  await audit(actor, {
    action: "payment_link.restored",
    business: link.business,
    target: { kind: "payment_link", id: link._id },
    summary: `Restored "${link.title}"`,
    details: { note },
  });
  const business = await BusinessModel.findById(link.business);
  if (business) await paymentLinkModerated(business, link, "restored");
  return link;
}

/** Takes one donation off the public list (it still counts towards the total). */
export async function setDonationHidden(actor: StaffActor, checkout: CheckoutDocument, hidden: boolean, note: string) {
  if (hidden === !!checkout.hidden?.at) return checkout;
  checkout.set("hidden", hidden ? { at: new Date(), by: actor.staff, note } : undefined);
  await checkout.save();
  const who = checkout.donor?.anonymous ? "an anonymous donor" : checkout.payer!.name;
  await audit(actor, {
    action: hidden ? "donation.hidden" : "donation.shown",
    business: checkout.business,
    target: { kind: "checkout", id: checkout._id },
    summary: hidden ? `Hid a donation from ${who} on the public list` : `Showed a donation from ${who} on the public list again`,
    details: { note, linkId: String(checkout.link) },
  });
  return checkout;
}

export type ReportResolution = {
  outcome: "dismissed" | "actioned";
  note: string;
  takeDownLink?: boolean;
  hideDonation?: boolean;
  flagBusiness?: { severity: "low" | "medium" | "high" };
};

/**
 * Closes a report. With `actioned`, staff can also take the link down, hide the reported donation and
 * raise a compliance flag on the business (category "Fraud report or customer complaint").
 */
export async function resolveLinkReport(actor: StaffActor, report: LinkReportDocument, input: ReportResolution) {
  if (report.status !== "open") throw new HttpError(409, "This report is already resolved", "REPORT_NOT_OPEN");
  const acting = input.outcome === "actioned";
  if (!acting && (input.takeDownLink || input.hideDonation || input.flagBusiness)) {
    throw new HttpError(400, "Choose \"actioned\" to take the link down, hide the donation or flag the business", "INVALID_RESOLUTION");
  }
  if (input.hideDonation && !report.checkout) throw new HttpError(400, "This report isn't about a donation", "INVALID_RESOLUTION");

  // Claim it first, so two staff members resolving at once can't both act.
  const claimed = await LinkReportModel.findOneAndUpdate(
    { _id: report._id, status: "open" },
    { status: "resolved", resolution: { outcome: input.outcome, note: input.note, by: actor.staff, at: new Date() } },
    { returnDocument: "after" },
  );
  if (!claimed) throw new HttpError(409, "This report is already resolved", "REPORT_NOT_OPEN");

  const actions: string[] = [];
  const link = await PaymentLinkModel.findById(report.link);
  if (input.takeDownLink && link) {
    await takeDownLink(actor, link, input.note);
    actions.push("took_down_link");
  }
  if (input.hideDonation && report.checkout) {
    const checkout = await CheckoutModel.findById(report.checkout);
    if (checkout) {
      await setDonationHidden(actor, checkout, true, input.note);
      actions.push("hid_donation");
    }
  }
  let flagId: Types.ObjectId | undefined;
  if (input.flagBusiness) {
    const business = await BusinessModel.findById(report.business).select("name");
    if (business) {
      const flag = await raiseFlag(actor, {
        business,
        category: "fraud_report",
        severity: input.flagBusiness.severity,
        summary: `Reported payment link "${link?.title ?? "deleted link"}": ${LINK_REPORT_REASONS[report.reason as LinkReportReason]}`,
        note: input.note,
        evidence: { metrics: { reportId: String(report._id), paymentLinkId: String(report.link), reason: report.reason } },
      });
      if (flag) {
        flagId = flag._id;
        actions.push("flagged_business");
      }
    }
  }
  claimed.set("resolution.actions", actions);
  if (flagId) claimed.set("resolution.flag", flagId);
  await claimed.save();

  await audit(actor, {
    action: "link_report.resolved",
    business: report.business,
    target: { kind: "link_report", id: report._id },
    summary: `${acting ? "Actioned" : "Dismissed"} a report about "${link?.title ?? "a deleted link"}"`,
    details: { outcome: input.outcome, note: input.note, actions },
  });
  return claimed;
}
