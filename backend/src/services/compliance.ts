// Compliance actions on a business: risk flags, suspending, reinstating, banning and lifting a ban.
// Every action is written to the audit log. Businesses are told that they're restricted, never why.
import type { Types } from "mongoose";
import {
  FLAG_CATEGORIES,
  SEVERITY_RANK,
  type ComplianceStatus,
  type FlagCategory,
  type FlagSeverity,
  type RiskRule,
} from "../config/compliance";
import { BusinessModel, type BusinessDocument } from "../models/Business";
import { ComplianceFlagModel, type ComplianceFlagDocument } from "../models/ComplianceFlag";
import { InviteModel } from "../models/Invite";
import { TransferModel } from "../models/Transfer";
import { UserModel } from "../models/User";
import { HttpError } from "../utils/HttpError";
import { audit, type Actor } from "./audit";
import { sendBusinessBannedEmail, sendBusinessReinstatedEmail, sendBusinessSuspendedEmail } from "./email";
import { businessRestrictedForStaff, businessRestrictionChanged, complianceFlagRaised } from "./notificationEvents";

type Id = Types.ObjectId | string;

export const complianceStatusOf = (business: { compliance?: { status?: string | null } | null }): ComplianceStatus =>
  (business.compliance?.status as ComplianceStatus | undefined) ?? "active";

/** What the business's own apps are told: whether it's restricted and since when. */
export function restrictionOf(business: BusinessDocument) {
  const status = complianceStatusOf(business);
  return { status, since: status === "active" ? null : (business.compliance?.since ?? null) };
}

/** Refuses money leaving a suspended or closed business. The route guard already blocks the requests; this guards the services. */
export function assertMoneyCanMove(business: { compliance?: { status?: string | null } | null }) {
  const status = complianceStatusOf(business);
  if (status === "banned") throw new HttpError(403, "This business has been closed. Contact support.", "BUSINESS_BANNED");
  if (status === "suspended") {
    throw new HttpError(403, "This business is suspended, so money can't be sent. Contact support.", "BUSINESS_SUSPENDED");
  }
}

// ---------------------------------------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------------------------------------

/** Keeps the counters on the business (used by list filters and sorting) in step with its flags. */
export async function refreshFlagSummary(businessId: Id) {
  const [open, latest] = await Promise.all([
    ComplianceFlagModel.find({ business: businessId, status: "open" }).select("severity"),
    ComplianceFlagModel.findOne({ business: businessId }).sort({ createdAt: -1 }).select("createdAt"),
  ]);
  const highest = open.reduce<FlagSeverity | null>(
    (top, f) => (!top || SEVERITY_RANK[f.severity as FlagSeverity] > SEVERITY_RANK[top] ? (f.severity as FlagSeverity) : top),
    null,
  );
  await BusinessModel.updateOne(
    { _id: businessId },
    {
      "compliance.openFlags": open.length,
      "compliance.highestOpenSeverity": highest,
      "compliance.lastFlaggedAt": latest?.get("createdAt") ?? null,
    },
  );
}

export type NewFlag = {
  business: Pick<BusinessDocument, "_id" | "name">;
  category: FlagCategory;
  severity: FlagSeverity;
  summary: string;
  note?: string;
  rule?: RiskRule;
  evidence?: { transactions?: Id[]; transfers?: Id[]; metrics?: Record<string, unknown> };
};

/**
 * Raises a flag and tells the compliance team. A rule flag returns null when that rule already has an
 * open flag on the business (one at a time).
 */
export async function raiseFlag(actor: Actor, input: NewFlag): Promise<ComplianceFlagDocument | null> {
  let flag: ComplianceFlagDocument;
  try {
    flag = await ComplianceFlagModel.create({
      business: input.business._id,
      source: input.rule ? "rule" : "staff",
      rule: input.rule,
      category: input.category,
      severity: input.severity,
      summary: input.summary,
      note: input.note,
      evidence: {
        transactions: input.evidence?.transactions ?? [],
        transfers: input.evidence?.transfers ?? [],
        metrics: input.evidence?.metrics ?? {},
      },
      raisedBy: actor.type === "staff" ? actor.staff : undefined,
    });
  } catch (err: any) {
    if (err?.code === 11000 && input.rule) return null;
    throw err;
  }
  await refreshFlagSummary(input.business._id);
  await audit(actor, {
    action: "flag.raised",
    business: input.business._id,
    target: { kind: "flag", id: flag._id },
    summary: `Flagged (${input.severity}): ${input.summary}`,
    details: { category: input.category, severity: input.severity, rule: input.rule ?? null, note: input.note ?? null },
  });
  await complianceFlagRaised(input.business, flag, { except: actor.type === "staff" ? actor.staff : null });
  return flag;
}

export async function resolveFlag(actor: Actor & { type: "staff" }, flag: ComplianceFlagDocument, outcome: "cleared" | "actioned", note: string) {
  const resolved = await ComplianceFlagModel.findOneAndUpdate(
    { _id: flag._id, status: "open" },
    { status: "resolved", resolution: { outcome, note, by: actor.staff, at: new Date() } },
    { returnDocument: "after" },
  );
  if (!resolved) throw new HttpError(409, "This flag is already resolved", "FLAG_NOT_OPEN");
  await refreshFlagSummary(flag.business);
  await audit(actor, {
    action: "flag.resolved",
    business: flag.business,
    target: { kind: "flag", id: flag._id },
    summary: `${outcome === "cleared" ? "Cleared" : "Actioned"} flag: ${flag.summary}`,
    details: { outcome, note },
  });
  return resolved;
}

// ---------------------------------------------------------------------------------------------------------
// Restrictions
// ---------------------------------------------------------------------------------------------------------

export type RestrictionInput = { reason: FlagCategory; note: string };

async function ownerEmail(business: BusinessDocument) {
  return (await UserModel.findById(business.owner).select("email"))?.email;
}

/** Moves the business from one of `from` to `to`, atomically, so two staff acting at once can't both succeed. */
async function setRestriction(business: BusinessDocument, from: ComplianceStatus[], to: ComplianceStatus, set: Record<string, unknown>) {
  // Businesses created before compliance existed have no `compliance.status` stored; they count as active.
  const statusFilter = from.includes("active") ? { $in: [...from, null] } : { $in: from };
  const updated = await BusinessModel.findOneAndUpdate(
    { _id: business._id, "compliance.status": statusFilter },
    { "compliance.status": to, ...set },
    { returnDocument: "after" },
  );
  if (!updated) {
    const current = complianceStatusOf((await BusinessModel.findById(business._id).select("compliance")) ?? business);
    throw new HttpError(409, `This business is ${current}`, current === "banned" ? "BUSINESS_BANNED" : current === "suspended" ? "BUSINESS_SUSPENDED" : "BUSINESS_NOT_RESTRICTED");
  }
  return updated;
}

/** Freezes the business while staff investigate: read-only for its team, no money out. */
export async function suspendBusiness(actor: Actor & { type: "staff" }, business: BusinessDocument, input: RestrictionInput) {
  if (business.status !== "approved") {
    throw new HttpError(409, "Only approved businesses can be suspended. Reject the verification or close the business instead.", "NOT_APPROVED");
  }
  const updated = await setRestriction(business, ["active"], "suspended", {
    "compliance.reason": input.reason,
    "compliance.note": input.note,
    "compliance.since": new Date(),
    "compliance.by": actor.staff,
  });
  await audit(actor, {
    action: "business.suspended",
    business: business._id,
    target: { kind: "business", id: business._id },
    summary: `Suspended: ${FLAG_CATEGORIES[input.reason]}`,
    details: { reason: input.reason, note: input.note },
  });
  await tellBusiness(updated, "suspended");
  await businessRestrictedForStaff(updated, "suspended", actor.name, actor.staff);
  return updated;
}

export async function reinstateBusiness(actor: Actor & { type: "staff" }, business: BusinessDocument, note: string) {
  const updated = await setRestriction(business, ["suspended"], "active", {
    $unset: { "compliance.reason": 1, "compliance.note": 1, "compliance.since": 1, "compliance.by": 1 },
  });
  await audit(actor, {
    action: "business.reinstated",
    business: business._id,
    target: { kind: "business", id: business._id },
    summary: "Suspension lifted",
    details: { note },
  });
  await tellBusiness(updated, "reinstated");
  return updated;
}

/**
 * Closes the business: every business route is refused, transfers waiting for approval are cancelled and
 * open team invites revoked. Approved transfers the bank partner hasn't accepted yet are held (never sent),
 * not cancelled, because a timed-out request may still have reached the bank partner.
 */
export async function banBusiness(actor: Actor & { type: "staff" }, business: BusinessDocument, input: RestrictionInput) {
  const updated = await setRestriction(business, ["active", "suspended"], "banned", {
    "compliance.reason": input.reason,
    "compliance.note": input.note,
    "compliance.since": new Date(),
    "compliance.by": actor.staff,
  });
  const [cancelled, revoked] = await Promise.all([
    TransferModel.updateMany(
      { business: business._id, status: "pending_approval" },
      { status: "cancelled", failureReason: "Cancelled because the business was closed", completedAt: new Date() },
    ),
    InviteModel.updateMany({ business: business._id, status: "pending" }, { status: "revoked" }),
  ]);
  await audit(actor, {
    action: "business.banned",
    business: business._id,
    target: { kind: "business", id: business._id },
    summary: `Closed (banned): ${FLAG_CATEGORIES[input.reason]}`,
    details: {
      reason: input.reason,
      note: input.note,
      previousStatus: complianceStatusOf(business),
      transfersCancelled: cancelled.modifiedCount,
      invitesRevoked: revoked.modifiedCount,
    },
  });
  await tellBusiness(updated, "banned");
  await businessRestrictedForStaff(updated, "banned", actor.name, actor.staff);
  return updated;
}

/** Lifts a ban. The business goes back to active (suspend it afterwards if it should stay frozen). */
export async function unbanBusiness(actor: Actor & { type: "staff" }, business: BusinessDocument, note: string) {
  const updated = await setRestriction(business, ["banned"], "active", {
    $unset: { "compliance.reason": 1, "compliance.note": 1, "compliance.since": 1, "compliance.by": 1 },
  });
  await audit(actor, {
    action: "business.unbanned",
    business: business._id,
    target: { kind: "business", id: business._id },
    summary: "Ban lifted",
    details: { note },
  });
  await tellBusiness(updated, "reinstated");
  return updated;
}

async function tellBusiness(business: BusinessDocument, change: "suspended" | "reinstated" | "banned") {
  await businessRestrictionChanged(business, change);
  const email = await ownerEmail(business);
  if (!email) return;
  const send = { suspended: sendBusinessSuspendedEmail, reinstated: sendBusinessReinstatedEmail, banned: sendBusinessBannedEmail }[change];
  await send(email, business.name).catch((err) => console.error(`Couldn't email the ${change} notice:`, err));
}
