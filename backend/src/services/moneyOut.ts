// Money-out protection: the checks every payment out of a business goes through on top of the approval
// rules, the emergency freeze, the holds after risky changes, and "This wasn't me" links.
// Contract: docs/briefs/money-out-security.md.
import { createHash, randomBytes } from "node:crypto";
import type { Request } from "express";
import type { Types } from "mongoose";
import { env } from "../config/env";
import { MONEY_OUT_PERMISSIONS, ROLE_PERMISSIONS, type TeamRole } from "../config/permissions";
import { SECURITY } from "../config/security";
import { BusinessModel, type BusinessDocument } from "../models/Business";
import type { MembershipDocument } from "../models/Membership";
import { SecurityReportModel, type SecurityReportSubject } from "../models/SecurityReport";
import { OPEN_REQUEST_STATUSES, SecurityRequestModel } from "../models/SecurityRequest";
import { SettlementAccountModel } from "../models/SettlementAccount";
import { UserModel, type UserDocument } from "../models/User";
import { HttpError } from "../utils/HttpError";
import { assertMoneyCanMove } from "./compliance";
import { sendSecurityEmail } from "./email";
import { membersWith, notifyUsers } from "./notifications";
import { logSecurityEvent, type SecurityActor } from "./securityEvents";

type Id = Types.ObjectId | string;

// ---------------------------------------------------------------------------------------------------------
// Who may move money right now
// ---------------------------------------------------------------------------------------------------------

export type MoneyOutBlocker = { code: string; message: string; until: Date | null };

const later = (date?: Date | null) => (date && date.getTime() > Date.now() ? date : null);

/**
 * Why this person can't move money out of this business right now, or null. Compliance restrictions are
 * checked separately. Without a business, only the person's own holds count (for unfreezing).
 */
export function moneyOutBlocker(
  business: Pick<BusinessDocument, "moneyOut"> | null,
  membership: Pick<MembershipDocument, "moneyOutAfter"> | null,
  user: Pick<UserDocument, "security"> | null,
): MoneyOutBlocker | null {
  if (business?.moneyOut?.frozen?.at) {
    return { code: "MONEY_OUT_FROZEN", message: "Money leaving this business is frozen. Nothing can be sent or withdrawn until it's unfrozen.", until: null };
  }
  const security = user?.security;
  if (security?.holdIndefinite) {
    return { code: "SECURITY_HOLD", message: "Your account is on hold after a security report. Contact support to have it checked.", until: null };
  }
  const hold = later(security?.holdUntil);
  if (hold) {
    return { code: "SECURITY_HOLD", message: "For your safety, you can't send money for 24 hours after changing your two-step verification.", until: hold };
  }
  const locked = later(security?.lockedUntil);
  if (locked) {
    return { code: "STEP_UP_LOCKED", message: "Too many wrong codes. You can't send money for a while.", until: locked };
  }
  const member = later(membership?.moneyOutAfter);
  if (member) {
    return { code: "NEW_MEMBER_HOLD", message: "New team members can't send or approve money for their first 24 hours.", until: member };
  }
  return null;
}

/**
 * Refuses money out when the business is restricted or frozen, or the person is on a hold. Use in every
 * service that sends, approves or withdraws money.
 */
export async function assertMoneyOutAllowed(business: BusinessDocument, membership: MembershipDocument | null, userId: Id) {
  assertMoneyCanMove(business);
  const user = await UserModel.findById(userId).select("security");
  const blocker = moneyOutBlocker(business, membership, user);
  if (blocker) throw new HttpError(423, blocker.message, blocker.code, { until: blocker.until });
}

/**
 * With "settlement accounts only" on, money can go only to the business's active settlement accounts and its
 * own branches. Checked when a transfer is made and again when it's approved.
 */
export async function assertRecipientsAllowed(
  business: Pick<BusinessDocument, "_id" | "moneyOut">,
  recipients: { kind: string; settlementAccount?: Id | null }[],
) {
  if (!business.moneyOut?.settlementOnly?.enabled) return;
  const ids = recipients.flatMap((r) => (r.kind !== "internal" && r.settlementAccount ? [r.settlementAccount] : []));
  const active = await SettlementAccountModel.countDocuments({ _id: { $in: ids }, business: business._id, status: "active" });
  const outside = recipients.filter((r) => r.kind !== "internal" && !r.settlementAccount).length;
  if (outside > 0 || active < new Set(ids.map(String)).size) {
    throw new HttpError(
      403,
      "This business only allows withdrawals to its settlement accounts and transfers between its own branches.",
      "SETTLEMENT_ONLY",
    );
  }
}

// ---------------------------------------------------------------------------------------------------------
// Contacts and "This wasn't me" links
// ---------------------------------------------------------------------------------------------------------

/** The owner and admins (who get every security email), plus the business's own email address. */
export async function securityContacts(business: Pick<BusinessDocument, "_id" | "owner" | "email">) {
  const ids = await membersWith(business, "team.manage");
  const users = await UserModel.find({ _id: { $in: ids } }).select("email");
  const emails = [...new Set([...users.map((u) => u.email), ...(business.email ? [business.email] : [])])];
  return { userIds: ids, emails };
}

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
export const hashReportToken = hashToken;

/** A personal "This wasn't me" link for one recipient of a security email. */
export async function createReportLink(input: {
  subject: SecurityReportSubject;
  user: Id;
  email: string;
  summary: string;
  business?: Id | null;
  request?: Id | null;
}) {
  const token = randomBytes(32).toString("base64url");
  await SecurityReportModel.create({
    tokenHash: hashToken(token),
    subject: input.subject,
    business: input.business ?? undefined,
    request: input.request ?? undefined,
    user: input.user,
    email: input.email,
    summary: input.summary,
    expiresAt: new Date(Date.now() + SECURITY.reportLinkTtlMs),
  });
  return `${env.webUrl}/security/report/${token}`;
}

/** Emails every contact; each gets their own report link when `report` is given. Never throws. */
export async function emailSecurityContacts(
  business: Pick<BusinessDocument, "_id" | "owner" | "email">,
  message: { subject: string; intro: string; details?: string[]; outro?: string },
  report?: { subject: SecurityReportSubject; user: Id; summary: string; request?: Id },
) {
  try {
    const { emails } = await securityContacts(business);
    for (const email of emails) {
      const reportLink = report ? await createReportLink({ ...report, business: business._id, email }) : undefined;
      await sendSecurityEmail(email, { ...message, reportLink });
    }
  } catch (err) {
    console.error("Couldn't send a security email:", err);
  }
}

// ---------------------------------------------------------------------------------------------------------
// Freezing
// ---------------------------------------------------------------------------------------------------------

export type FreezeSource = "member" | "report" | "staff";
// A stronger source replaces a weaker one: a freeze from a report or staff can only be lifted by staff.
const STRENGTH: Record<FreezeSource, number> = { member: 1, report: 2, staff: 2 };

/**
 * Stops all money leaving the business: no new transfers, approvals or withdrawals, and approved transfers
 * not yet handed to the bank are held. Open settlement changes are cancelled. Idempotent.
 */
export async function freezeMoneyOut(
  business: BusinessDocument,
  actor: Extract<SecurityActor, { type: "user" | "staff" | "report" }>,
  reason?: string,
  req?: Request,
) {
  const source: FreezeSource = actor.type === "user" ? "member" : actor.type;
  const current = business.moneyOut?.frozen;
  if (current?.at && STRENGTH[(current.source as FreezeSource) ?? "member"] >= STRENGTH[source]) return business;

  business.set("moneyOut.frozen", { at: new Date(), source, by: actor.id, byName: actor.name, reason: reason || undefined });
  await business.save();
  await cancelOpenRequests(business, { by: source, byId: actor.id, byName: actor.name, reason: "Money out was frozen" });

  await logSecurityEvent({
    type: "money_out.frozen",
    actor,
    business: business._id,
    summary: `${actor.name} froze money leaving the business${reason ? `: ${reason}` : ""}`,
    details: { source },
    req,
  });
  const who = source === "member" ? actor.name : "LinkPay";
  await notifyUsers(
    await membersWith(business, "accounts.view"),
    {
      type: "security.money_out_frozen",
      title: "Money out frozen",
      body: `${who} froze money leaving ${business.name}. Nothing can be sent or withdrawn until it's unfrozen. Money can still come in.`,
      link: "/settings/money-protection",
      data: { businessId: String(business._id) },
    },
    business,
  );
  await emailSecurityContacts(business, {
    subject: `Money leaving ${business.name} is frozen`,
    intro: `${who} froze money leaving ${business.name}${source === "report" ? " after someone used a \"This wasn't me\" link" : ""}.`,
    details: ["No transfers, approvals or withdrawals can go out.", "Payments into your accounts still arrive."],
    outro:
      source === "member"
        ? "The owner can unfreeze it under Settings, Money protection, with a two-step code."
        : "We'll contact you to check your account before unfreezing it. You can also contact support.",
  });
  return business;
}

/** Lifts a freeze. Callers check who may (the owner for a member's freeze, staff for the rest). */
export async function unfreezeMoneyOut(business: BusinessDocument, actor: SecurityActor, req?: Request) {
  if (!business.moneyOut?.frozen?.at) throw new HttpError(409, "Money out isn't frozen", "NOT_FROZEN");
  business.set("moneyOut.frozen", { at: undefined, source: null, by: undefined, byName: undefined, reason: undefined });
  await business.save();
  await logSecurityEvent({ type: "money_out.unfrozen", actor, business: business._id, summary: `${actor.name} unfroze money leaving the business`, req });
  await notifyUsers(
    await membersWith(business, "accounts.view"),
    {
      type: "security.money_out_unfrozen",
      title: "Money out unfrozen",
      body: `${actor.type === "staff" ? "LinkPay" : actor.name} unfroze ${business.name}. Transfers and withdrawals can go out again.`,
      link: "/settings/money-protection",
      data: { businessId: String(business._id) },
    },
    business,
  );
  await emailSecurityContacts(business, {
    subject: `Money can leave ${business.name} again`,
    intro: `${actor.type === "staff" ? "LinkPay" : actor.name} unfroze money leaving ${business.name}. Transfers and withdrawals can go out again.`,
  });
  return business;
}

/** Cancels the business's open settlement changes (on a freeze or a report). */
export async function cancelOpenRequests(
  business: Pick<BusinessDocument, "_id">,
  cancellation: { by: "member" | "report" | "staff"; byId?: Id; byName: string; reason: string },
) {
  const open = await SecurityRequestModel.find({ business: business._id, status: { $in: OPEN_REQUEST_STATUSES } });
  for (const request of open) {
    const done = await SecurityRequestModel.findOneAndUpdate(
      { _id: request._id, status: { $in: OPEN_REQUEST_STATUSES } },
      { status: "cancelled", cancellation: { ...cancellation, at: new Date() } },
    );
    if (done && request.settlementAccount) {
      await SettlementAccountModel.updateOne({ _id: request.settlementAccount, status: "pending" }, { status: "cancelled", endedAt: new Date() });
    }
  }
  return open.length;
}

// ---------------------------------------------------------------------------------------------------------
// Holds after risky changes
// ---------------------------------------------------------------------------------------------------------

/**
 * After a two-step (2FA) change the person can't move money for 24 hours, and is emailed with a
 * "This wasn't me" link: someone who stole a password could otherwise switch on their own authenticator
 * and pass every later check.
 */
export async function startTwoFactorHold(user: UserDocument, change: string, req?: Request) {
  const until = new Date(Date.now() + SECURITY.twoFactorHoldMs);
  const current = user.security?.holdUntil;
  if (!current || current.getTime() < until.getTime()) {
    await UserModel.updateOne({ _id: user._id }, { "security.holdUntil": until, "security.holdReason": "two_factor_changed" });
  }
  await logSecurityEvent({
    type: "two_factor.changed",
    actor: { type: "user", id: user._id, name: user.name },
    user: user._id,
    summary: `${user.name} ${change}. Money out is paused for 24 hours.`,
    details: { change, until },
    req,
  });
  await notifyUsers([user._id], {
    type: "security.two_factor_changed",
    title: "Two-step verification changed",
    body: `You ${change}. For your safety you can't send money for 24 hours. If this wasn't you, contact support now.`,
    link: "/settings",
  });
  try {
    const summary = `${change.charAt(0).toUpperCase()}${change.slice(1)} for ${user.email}`
    const reportLink = await createReportLink({ subject: "two_factor", user: user._id, email: user.email, summary });
    await sendSecurityEmail(user.email, {
      subject: `Your ${env.appName} two-step verification changed`,
      intro: `Someone signed in as you ${change}${req?.ip ? ` (from ${req.ip})` : ""}.`,
      details: [`For your safety, you can't send, approve or withdraw money until ${until.toUTCString()}.`],
      reportLink,
    });
  } catch (err) {
    console.error("Couldn't send the two-step change email:", err);
  }
}

const movesMoney = (role: TeamRole) => ROLE_PERMISSIONS[role].some((p) => MONEY_OUT_PERMISSIONS.includes(p));

/**
 * A new member (or one moved to a role that moves money) waits 24 hours before they can: someone using a
 * stolen owner login could otherwise invite their own account and send money from it.
 */
export async function startMemberHoldIfNeeded(membership: MembershipDocument, previousRole: TeamRole | null) {
  if (membership.role === "owner" || !movesMoney(membership.role)) return;
  const gained = ROLE_PERMISSIONS[membership.role].filter((p) => MONEY_OUT_PERMISSIONS.includes(p) && !(previousRole && ROLE_PERMISSIONS[previousRole].includes(p)));
  if (!gained.length) return;
  const until = new Date(Date.now() + SECURITY.newMemberHoldMs);
  await membership.updateOne({ moneyOutAfter: until });
  membership.set("moneyOutAfter", until);
  const user = await UserModel.findById(membership.user).select("name");
  await logSecurityEvent({
    type: "member.hold_started",
    actor: { type: "system", name: "LinkPay" },
    business: membership.business,
    user: membership.user,
    summary: `${user?.name ?? "A team member"} can send or approve money from ${until.toUTCString()}`,
    details: { role: membership.role, until },
  });
}

/** Turns on "settlement accounts only" (immediate: it only narrows where money can go). */
export async function enableSettlementOnly(business: BusinessDocument, actor: Extract<SecurityActor, { type: "user" }>, req?: Request) {
  if (business.moneyOut?.settlementOnly?.enabled) return business;
  business.set("moneyOut.settlementOnly", { enabled: true, since: new Date(), by: actor.id });
  await business.save();
  await logSecurityEvent({
    type: "settlement_only.enabled",
    actor,
    business: business._id,
    summary: `${actor.name} turned on "settlement accounts only"`,
    req,
  });
  await notifyUsers(
    await membersWith(business, "accounts.view"),
    {
      type: "security.protection_changed",
      title: "Settlement accounts only",
      body: `${actor.name} turned on "settlement accounts only" for ${business.name}. Money can now leave only to its settlement accounts and between its branches.`,
      link: "/settings/money-protection",
      data: { businessId: String(business._id) },
    },
    business,
  );
  await emailSecurityContacts(business, {
    subject: `${business.name}: settlement accounts only`,
    intro: `${actor.name} turned on "settlement accounts only". Money can now leave only to the business's settlement accounts and between its own branches.`,
    outro: "Turning it off takes 72 hours and a review by LinkPay.",
  });
  return business;
}

/** Re-reads the business (after a change made by another request). */
export const reloadBusiness = (id: Id) => BusinessModel.findById(id);
