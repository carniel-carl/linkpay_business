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
import { publishLinkEvent } from "./linkStream";
import { linkReported, paymentLinkModerated } from "./notificationEvents";

type StaffActor = Actor & { type: "staff" };

// ---------------------------------------------------------------------------------------------------------
// The public donor list
// ---------------------------------------------------------------------------------------------------------

export const DONATION_SORTS = ["recent", "top"] as const;
export type DonationSort = (typeof DONATION_SORTS)[number];

/**
 * Donations that arrived and that staff haven't hidden. Test-mode payments show only while the link itself is
 * in test mode, so the business can see a simulated gift land; they vanish once it goes live.
 */
const shownDonations = (link: Pick<PaymentLinkDocument, "_id" | "mode">): Record<string, unknown> => ({
  link: link._id,
  status: { $in: ["paid", "underpaid"] },
  ...(link.mode !== "test" && { mode: { $ne: "test" } }),
  testClearedAt: { $exists: false },
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
    // A simulated gift, shown while the link is in test mode.
    test: c.mode === "test",
  };
}

/**
 * One page of a donation link's donors, newest (`recent`) or largest (`top`) first.
 * `before` is the `nextBefore` of the previous page.
 */
export async function listPublicDonations(link: PaymentLinkDocument, opts: { sort: DonationSort; before?: string; take: number }) {
  const field = opts.sort === "top" ? "paidKobo" : "paidAt";
  const filter: Record<string, unknown> = shownDonations(link);
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

/** Simulated payments per link (test checkouts that were "paid"), keyed by link id. */
export async function testTotals(linkIds: Types.ObjectId[]) {
  const totals = new Map<string, { kobo: number; count: number; last: Date | null }>();
  if (!linkIds.length) return totals;
  const rows = await CheckoutModel.aggregate<{ _id: Types.ObjectId; kobo: number; count: number; last: Date | null }>([
    { $match: { link: { $in: linkIds }, mode: "test", status: { $in: ["paid", "underpaid"] }, testClearedAt: { $exists: false } } },
    { $group: { _id: "$link", kobo: { $sum: "$paidKobo" }, count: { $sum: 1 }, last: { $max: "$paidAt" } } },
  ]);
  for (const r of rows) totals.set(String(r._id), { kobo: r.kobo, count: r.count, last: r.last });
  return totals;
}

/**
 * A fundraiser's figures with its test gifts counted, while the link is in test mode (`testKobo` says how much
 * of `raisedKobo` is test money). Live, they're the link's own totals and `testKobo` is 0. Used by the public
 * page and the dashboard, so both show the same; real totals (`collectedKobo`) and balances never include them.
 */
export function progressWithTestGifts(link: PaymentLinkDocument, test: { kobo: number; count: number; last: Date | null } | undefined) {
  const live = donationProgress(link);
  if (link.mode !== "test" || !test) return { ...live, testKobo: 0 };
  const raisedKobo = live.raisedKobo + test.kobo;
  const last = [live.lastDonationAt, test.last].filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  return {
    ...live,
    raisedKobo,
    donationsCount: live.donationsCount + test.count,
    percent: live.goalKobo ? Math.floor((raisedKobo / live.goalKobo) * 100) : null,
    lastDonationAt: last,
    testKobo: test.kobo,
  };
}

/** The figures the public page shows (see `progressWithTestGifts`). */
export async function publicDonationProgress(link: PaymentLinkDocument) {
  if (link.mode !== "test") return progressWithTestGifts(link, undefined);
  return progressWithTestGifts(link, (await testTotals([link._id])).get(link.id));
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
      ? await CheckoutModel.findOne({ _id: input.donationId, ...shownDonations(link) })
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
  publishLinkEvent(link._id, "link");
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
  publishLinkEvent(link._id, "link");
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
  publishLinkEvent(checkout.link, "link");
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
