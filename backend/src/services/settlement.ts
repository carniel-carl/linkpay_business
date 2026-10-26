// Settlement accounts (where a business withdraws its money to), the reviews that loosen where money can go,
// and "This wasn't me" reports. Contract: docs/briefs/money-out-security.md.
import type { Request } from "express";
import type { Types } from "mongoose";
import { SECURITY } from "../config/security";
import { BusinessModel, type BusinessDocument } from "../models/Business";
import { MembershipModel } from "../models/Membership";
import { SecurityEventModel } from "../models/SecurityEvent";
import { SecurityReportModel } from "../models/SecurityReport";
import { OPEN_REQUEST_STATUSES, SecurityRequestModel, type SecurityRequestDocument } from "../models/SecurityRequest";
import { SessionModel } from "../models/Session";
import { OPEN_SETTLEMENT_STATUSES, SettlementAccountModel, type SettlementAccountDocument } from "../models/SettlementAccount";
import { TransferModel } from "../models/Transfer";
import { UserModel } from "../models/User";
import { HttpError } from "../utils/HttpError";
import { audit, type Actor } from "./audit";
import { raiseFlag } from "./compliance";
import { formatNaira } from "./email";
import {
  assertMoneyOutAllowed,
  cancelOpenRequests,
  emailSecurityContacts,
  freezeMoneyOut,
  hashReportToken,
  securityContacts,
} from "./moneyOut";
import { checkSettlementName, nameWords, type NameCheck } from "./nameMatch";
import { notifyStaff, notifyUsers, staffWith } from "./notifications";
import { clientOf, logSecurityEvent, userActor, type SecurityActor } from "./securityEvents";
import { revokeOtherSessions } from "./sessions";
import type { StepUpContext } from "./stepUp";
import { createTransfers, resolveBankRecipient } from "./transfers";

type Id = Types.ObjectId | string;
const DAY = 24 * 60 * 60 * 1000;
const HOURS = (ms: number) => Math.round(ms / (60 * 60 * 1000));

export const describeAccount = (a: Pick<SettlementAccountDocument, "accountName" | "accountNumber" | "bankName">) =>
  `${a.accountName}, ${a.accountNumber} (${a.bankName ?? "bank"})`;

const PROTECTION_LINK = "/settings/money-protection";

// ---------------------------------------------------------------------------------------------------------
// Checking an account
// ---------------------------------------------------------------------------------------------------------

/**
 * Name enquiry plus the name check. Refuses the business's own LinkPay accounts, other LinkPay businesses'
 * accounts, and accounts whose name doesn't belong to the business.
 */
export async function checkSettlementAccount(business: BusinessDocument, accountNumber: string, bankUuid: string) {
  const recipient = await resolveBankRecipient(business, accountNumber, bankUuid);
  if (recipient.kind === "internal") {
    throw new HttpError(400, "This is one of your LinkPay accounts. A settlement account is your account at another bank.", "SETTLEMENT_OWN_ACCOUNT");
  }
  if (recipient.kind === "linkpay") {
    throw new HttpError(400, "This account belongs to another business on LinkPay. A settlement account must be your own.", "SETTLEMENT_LINKPAY_ACCOUNT");
  }
  const nameCheck = checkSettlementName(business, recipient.accountName);
  if (!nameCheck) {
    const allowed = [business.name, ...(business.people ?? []).filter((p) => p.roles.some((r) => r === "owner" || r === "partner")).map((p) => p.fullName)];
    throw new HttpError(
      422,
      `This account is in the name "${recipient.accountName}". A settlement account must be in your business's name${allowed.length > 1 ? " or an owner's" : ""}.`,
      "SETTLEMENT_NAME_MISMATCH",
      { accountName: recipient.accountName },
    );
  }
  return { recipient, nameCheck };
}

// ---------------------------------------------------------------------------------------------------------
// What the reviewer sees
// ---------------------------------------------------------------------------------------------------------

type Signals = Record<string, unknown> & { risk: "low" | "medium" | "high"; reasons: string[] };

/** A snapshot of everything that helps a reviewer tell the real team from someone with a stolen login. */
async function gatherSignals(
  business: BusinessDocument,
  userId: Id,
  req: Request | undefined,
  account?: { accountNumber: string; bankUuid: string; nameCheck: NameCheck },
): Promise<Signals> {
  const now = Date.now();
  const [user, membership, twoFactorChange, failedCodes, newDevices, requests30d, activeCount, everCount, shared, paidBefore] = await Promise.all([
    UserModel.findById(userId).select("name email twoFactor createdAt lastSignInAt lastSignInIp"),
    MembershipModel.findOne({ business: business._id, user: userId }),
    SecurityEventModel.findOne({ user: userId, type: "two_factor.changed", createdAt: { $gte: new Date(now - 30 * DAY) } }).sort({ createdAt: -1 }),
    SecurityEventModel.countDocuments({ user: userId, type: "step_up.failed", createdAt: { $gte: new Date(now - 7 * DAY) } }),
    SessionModel.countDocuments({ user: userId, createdAt: { $gte: new Date(now - 7 * DAY) } }),
    SecurityRequestModel.countDocuments({ business: business._id, createdAt: { $gte: new Date(now - 30 * DAY) } }),
    SettlementAccountModel.countDocuments({ business: business._id, status: "active" }),
    SettlementAccountModel.countDocuments({ business: business._id }),
    account
      ? SettlementAccountModel.find({ accountNumber: account.accountNumber, bankUuid: account.bankUuid, business: { $ne: business._id }, status: { $in: OPEN_SETTLEMENT_STATUSES } }).select("business")
      : Promise.resolve([]),
    account ? TransferModel.countDocuments({ business: business._id, "recipient.accountNumber": account.accountNumber, status: "success" }) : Promise.resolve(0),
  ]);
  const sharedWith = await BusinessModel.find({ _id: { $in: shared.map((s) => s.business) } }).select("name");
  const ip = req?.ip;
  const twoFactorChangedAt = twoFactorChange?.get("createdAt") as Date | undefined;

  const reasons: string[] = [];
  let risk: Signals["risk"] = "low";
  const raise = (level: Signals["risk"], reason: string) => {
    reasons.push(reason);
    if (level === "high" || (level === "medium" && risk === "low")) risk = level;
  };
  if (twoFactorChangedAt && now - twoFactorChangedAt.getTime() < 7 * DAY) raise("high", "Two-step verification changed in the last 7 days");
  if (sharedWith.length) raise("high", `The same account is a settlement account of ${sharedWith.map((b) => b.name).join(", ")}`);
  if (account?.nameCheck.result === "partial") raise("medium", account.nameCheck.note ?? `Name only partly matches ${account.nameCheck.matchedName}`);
  if (failedCodes > 0) raise("medium", `${failedCodes} wrong confirmation code${failedCodes === 1 ? "" : "s"} in the last 7 days`);
  if (newDevices > 0) raise("medium", `Signed in on ${newDevices} new phone${newDevices === 1 ? "" : "s"} in the last 7 days`);
  if (requests30d > 2) raise("medium", `${requests30d} settlement changes in the last 30 days`);
  if (activeCount > 0 && account) raise("low", "The business already has an active settlement account");
  if (ip && user?.lastSignInIp && ip !== user.lastSignInIp) raise("low", "Asked from a different address than the last sign-in");
  if (!user?.twoFactor?.enabled || user.twoFactor.method !== "totp") raise("low", "Uses email codes, not an authenticator app");

  return {
    risk,
    reasons,
    ...(account && { nameCheck: account.nameCheck }),
    requester: {
      _id: String(userId),
      name: user?.name ?? null,
      email: user?.email ?? null,
      role: membership?.role ?? null,
      memberSince: membership?.get("createdAt") ?? null,
      twoFactor: user?.twoFactor?.enabled ? user.twoFactor.method : null,
      lastSignInAt: user?.lastSignInAt ?? null,
      lastSignInIp: user?.lastSignInIp ?? null,
    },
    ip: ip ?? null,
    userAgent: req?.get("user-agent") ?? null,
    twoFactorChangedAt: twoFactorChangedAt ?? null,
    failedCodes7d: failedCodes,
    newDevices7d: newDevices,
    settlementChanges30d: requests30d,
    activeSettlementAccounts: activeCount,
    firstEver: everCount === 0,
    paidBefore,
    sharedWith: sharedWith.map((b) => ({ _id: b.id as string, name: b.name })),
    businessApprovedAt: business.reviewedAt ?? null,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Adding, cancelling and removing (the business)
// ---------------------------------------------------------------------------------------------------------

/**
 * Adds a settlement account waiting for review. Needs two-step verification on, the password again and a
 * step-up (checked by the route). Starts the cooling-off, emails the owner and admins with "This wasn't me"
 * links and puts it in the staff review queue.
 */
export async function addSettlementAccount(ctx: StepUpContext, input: { accountNumber: string; bankUuid: string; password: string }, req?: Request) {
  const { business, membership, userId } = ctx;
  await assertMoneyOutAllowed(business, membership, userId);
  const user = await UserModel.findById(userId).select("+password name twoFactor");
  if (!user) throw new HttpError(401, "Sign in again", "UNAUTHENTICATED");
  if (!user.twoFactor?.enabled) {
    throw new HttpError(403, "Turn on two-step verification before adding a settlement account.", "TWO_FACTOR_REQUIRED");
  }
  if (!(await Bun.password.verify(input.password, user.password))) throw new HttpError(401, "Incorrect password", "INCORRECT_PASSWORD");

  const open = await SettlementAccountModel.find({ business: business._id, status: { $in: OPEN_SETTLEMENT_STATUSES } });
  if (open.some((a) => a.accountNumber === input.accountNumber && a.bankUuid === input.bankUuid)) {
    throw new HttpError(409, "This account is already a settlement account (or waiting for review).", "SETTLEMENT_EXISTS");
  }
  if (open.length >= SECURITY.maxSettlementAccounts) {
    throw new HttpError(409, `You can have up to ${SECURITY.maxSettlementAccounts} settlement accounts. Remove one to add another.`, "SETTLEMENT_LIMIT");
  }

  const { recipient, nameCheck } = await checkSettlementAccount(business, input.accountNumber, input.bankUuid);
  const signals = await gatherSignals(business, userId, req, { accountNumber: input.accountNumber, bankUuid: input.bankUuid, nameCheck });

  let account: SettlementAccountDocument;
  try {
    account = await SettlementAccountModel.create({
      business: business._id,
      accountNumber: recipient.accountNumber,
      accountName: recipient.accountName,
      bankUuid: recipient.bankUuid,
      bankName: recipient.bankName,
      nameCheck,
      status: "pending",
      addedBy: userId,
    });
  } catch (err: any) {
    if (err?.code === 11000) throw new HttpError(409, "This account is already a settlement account (or waiting for review).", "SETTLEMENT_EXISTS");
    throw err;
  }
  const availableAt = new Date(Date.now() + SECURITY.settlementCoolingOffMs);
  const request = await SecurityRequestModel.create({
    business: business._id,
    kind: "settlement_account",
    settlementAccount: account._id,
    requestedBy: userId,
    ...clientOf(req),
    availableAt,
    signals,
  });
  account.set("request", request._id);
  await account.save();

  const described = describeAccount(account);
  await logSecurityEvent({
    type: "settlement.requested",
    actor: { type: "user", id: userId, name: user.name },
    business: business._id,
    summary: `${user.name} added ${described} as a settlement account`,
    details: { settlementAccount: account.id, nameCheck: nameCheck.result },
    req,
  });
  await notifyUsers(
    (await securityContacts(business)).userIds,
    {
      type: "security.settlement_requested",
      title: "Settlement account added",
      body: `${user.name} added ${described}. LinkPay will check it, and it can't be used before ${availableAt.toUTCString()}. If this wasn't your team, freeze money out now.`,
      link: PROTECTION_LINK,
      data: { businessId: String(business._id), settlementAccountId: account.id },
    },
    business,
  );
  await emailSecurityContacts(
    business,
    {
      subject: `New settlement account for ${business.name}`,
      intro: `${user.name} added a settlement account to ${business.name}. Money withdrawn from the business can be sent to it.`,
      details: [
        `Account: ${described}`,
        `Added from: ${req?.ip ?? "unknown address"}`,
        `LinkPay will review it and may call you on a number from your verification.`,
        `It can't be used before ${availableAt.toUTCString()}.`,
      ],
    },
    { subject: "settlement_account", user: userId, summary: `Settlement account ${described}`, request: request._id },
  );
  await notifyStaff(await staffWith("security.review"), {
    type: "security.review_requested",
    title: `Settlement account: ${business.name}`,
    body: `${described} (${nameCheck.result} name match, ${signals.risk} risk).`,
    link: `/security-reviews/${request.id}`,
    data: { businessId: String(business._id), requestId: request.id },
  });
  return account;
}

async function findAccount(business: Pick<BusinessDocument, "_id">, id: Id) {
  const account = await SettlementAccountModel.findOne({ _id: id, business: business._id });
  if (!account) throw new HttpError(404, "Settlement account not found", "SETTLEMENT_NOT_FOUND");
  return account;
}

/** Withdraws a settlement account still waiting for review. No step-up: it only takes a destination away. */
export async function cancelSettlementAccount(ctx: StepUpContext, id: Id, req?: Request) {
  const account = await findAccount(ctx.business, id);
  if (account.status !== "pending") throw new HttpError(409, "Only accounts waiting for review can be cancelled", "SETTLEMENT_NOT_PENDING");
  const actor = await userActor(ctx.userId);
  await SecurityRequestModel.updateOne(
    { _id: account.request, status: { $in: OPEN_REQUEST_STATUSES } },
    { status: "cancelled", cancellation: { by: "member", byId: ctx.userId, byName: actor.name, at: new Date() } },
  );
  account.set({ status: "cancelled", endedAt: new Date(), endedBy: ctx.userId });
  await account.save();
  await logSecurityEvent({ type: "settlement.cancelled", actor, business: ctx.business._id, summary: `${actor.name} cancelled ${describeAccount(account)}`, req });
  return account;
}

/** Takes an active settlement account off. */
export async function removeSettlementAccount(ctx: StepUpContext, id: Id, req?: Request) {
  const account = await findAccount(ctx.business, id);
  if (account.status === "pending") return cancelSettlementAccount(ctx, id, req);
  if (account.status !== "active") throw new HttpError(409, "This settlement account isn't active", "SETTLEMENT_NOT_ACTIVE");
  const actor = await userActor(ctx.userId);
  account.set({ status: "removed", endedAt: new Date(), endedBy: ctx.userId });
  await account.save();
  const described = describeAccount(account);
  await logSecurityEvent({ type: "settlement.removed", actor, business: ctx.business._id, summary: `${actor.name} removed ${described}`, req });
  await notifyUsers(
    (await securityContacts(ctx.business)).userIds,
    { type: "security.settlement_removed", title: "Settlement account removed", body: `${actor.name} removed ${described}.`, link: PROTECTION_LINK },
    ctx.business,
  );
  await emailSecurityContacts(ctx.business, {
    subject: `Settlement account removed from ${ctx.business.name}`,
    intro: `${actor.name} removed the settlement account ${described}. Nothing more can be withdrawn to it.`,
  });
  return account;
}

// ---------------------------------------------------------------------------------------------------------
// Withdrawing
// ---------------------------------------------------------------------------------------------------------

const sameName = (a: string, b: string) => nameWords(a).sort().join(" ") === nameWords(b).sort().join(" ");

/**
 * Sends money from a branch to an active settlement account. It's an ordinary transfer (the approval
 * rules apply) marked with the settlement account. The account's name is checked with the bank again first.
 */
export async function withdrawToSettlement(
  ctx: StepUpContext,
  input: { id: Id; branch: string; amountKobo: number; narration?: string; clientKey?: string },
  req?: Request,
) {
  await completeDueRequests({ business: ctx.business._id });
  const account = await findAccount(ctx.business, input.id);
  if (account.status !== "active") {
    throw new HttpError(409, account.status === "pending" ? "This settlement account is still waiting for review." : "This settlement account isn't active.", "SETTLEMENT_NOT_ACTIVE");
  }
  const fresh = await resolveBankRecipient(ctx.business, account.accountNumber, account.bankUuid);
  if (fresh.kind !== "bank" || !sameName(fresh.accountName, account.accountName)) {
    await logSecurityEvent({
      type: "settlement.name_changed",
      actor: { type: "system", name: "LinkPay" },
      business: ctx.business._id,
      summary: `The bank now names ${account.accountNumber} "${fresh.accountName}" (was "${account.accountName}")`,
      req,
    });
    await raiseFlag(
      { type: "system", name: "Settlement checks" },
      {
        business: ctx.business,
        category: "account_security",
        severity: "medium",
        summary: `Settlement account ${account.accountNumber} changed name to "${fresh.accountName}" (was "${account.accountName}")`,
      },
    );
    throw new HttpError(409, "The bank now shows a different name on this account, so we've stopped this withdrawal. Contact support.", "SETTLEMENT_NAME_CHANGED");
  }

  const result = await createTransfers({
    business: ctx.business,
    membership: ctx.membership,
    userId: ctx.userId,
    branchId: input.branch,
    requests: [{ recipient: fresh, amountKobo: input.amountKobo, narration: input.narration, settlementAccount: account._id }],
    clientKey: input.clientKey,
  });
  if (!result.replayed) {
    await SettlementAccountModel.updateOne({ _id: account._id }, { lastWithdrawalAt: new Date() });
    const actor = await userActor(ctx.userId);
    await logSecurityEvent({
      type: "withdrawal.created",
      actor,
      business: ctx.business._id,
      summary: `${actor.name} withdrew ${formatNaira(input.amountKobo)} to ${describeAccount(account)}`,
      details: { transfer: result.transfers[0]?.id },
      req,
    });
  }
  return result;
}

// ---------------------------------------------------------------------------------------------------------
// "Settlement accounts only": asking to turn it off
// ---------------------------------------------------------------------------------------------------------

export async function requestSettlementOnlyOff(ctx: StepUpContext, req?: Request) {
  const { business, membership, userId } = ctx;
  if (!business.moneyOut?.settlementOnly?.enabled) throw new HttpError(409, "\"Settlement accounts only\" isn't on", "SETTLEMENT_ONLY_OFF");
  await assertMoneyOutAllowed(business, membership, userId);
  const actor = await userActor(userId);
  const availableAt = new Date(Date.now() + SECURITY.lockRemovalCoolingOffMs);
  let request: SecurityRequestDocument;
  try {
    request = await SecurityRequestModel.create({
      business: business._id,
      kind: "settlement_only_off",
      requestedBy: userId,
      ...clientOf(req),
      availableAt,
      signals: await gatherSignals(business, userId, req),
    });
  } catch (err: any) {
    if (err?.code === 11000) throw new HttpError(409, "There's already a request to turn this off.", "REQUEST_EXISTS");
    throw err;
  }
  await logSecurityEvent({ type: "settlement_only.off_requested", actor, business: business._id, summary: `${actor.name} asked to turn off "settlement accounts only"`, req });
  await notifyUsers(
    (await securityContacts(business)).userIds,
    {
      type: "security.protection_changed",
      title: "Request to loosen money-out protection",
      body: `${actor.name} asked to turn off "settlement accounts only". LinkPay will review it, and it can't happen before ${availableAt.toUTCString()}.`,
      link: PROTECTION_LINK,
      data: { businessId: String(business._id), requestId: request.id },
    },
    business,
  );
  await emailSecurityContacts(
    business,
    {
      subject: `Request to turn off "settlement accounts only" for ${business.name}`,
      intro: `${actor.name} asked to turn off "settlement accounts only" for ${business.name}. Once off, money can be sent to any bank account again.`,
      details: [`Asked from: ${req?.ip ?? "unknown address"}`, `LinkPay will review it. It can't happen before ${availableAt.toUTCString()}.`],
    },
    { subject: "settlement_only_off", user: userId, summary: "Turning off \"settlement accounts only\"", request: request._id },
  );
  await notifyStaff(await staffWith("security.review"), {
    type: "security.review_requested",
    title: `Protection change: ${business.name}`,
    body: `${actor.name} asked to turn off "settlement accounts only".`,
    link: `/security-reviews/${request.id}`,
    data: { businessId: String(business._id), requestId: request.id },
  });
  return request;
}

export async function cancelSettlementOnlyOff(ctx: StepUpContext, req?: Request) {
  const actor = await userActor(ctx.userId);
  const request = await SecurityRequestModel.findOneAndUpdate(
    { business: ctx.business._id, kind: "settlement_only_off", status: { $in: OPEN_REQUEST_STATUSES } },
    { status: "cancelled", cancellation: { by: "member", byId: ctx.userId, byName: actor.name, at: new Date() } },
    { returnDocument: "after" },
  );
  if (!request) throw new HttpError(404, "There's no request to cancel", "REQUEST_NOT_FOUND");
  await logSecurityEvent({ type: "settlement_only.off_cancelled", actor, business: ctx.business._id, summary: `${actor.name} cancelled the request to turn off "settlement accounts only"`, req });
  return request;
}

// ---------------------------------------------------------------------------------------------------------
// Taking effect after review and cooling-off
// ---------------------------------------------------------------------------------------------------------

/** Puts approved requests whose cooling-off has ended into effect. Safe to run often and concurrently. */
export async function completeDueRequests(filter: { business?: Id; _id?: Id } = {}) {
  const due = await SecurityRequestModel.find({ ...filter, status: "approved", availableAt: { $lte: new Date() } }).limit(200);
  let completed = 0;
  for (const candidate of due) {
    const request = await SecurityRequestModel.findOneAndUpdate(
      { _id: candidate._id, status: "approved" },
      { status: "completed", completedAt: new Date() },
      { returnDocument: "after" },
    );
    if (!request) continue;
    completed++;
    const business = await BusinessModel.findById(request.business);
    if (!business) continue;
    if (request.kind === "settlement_account") {
      const account = await SettlementAccountModel.findOneAndUpdate(
        { _id: request.settlementAccount, status: "pending" },
        { status: "active", activatedAt: new Date() },
        { returnDocument: "after" },
      );
      if (!account) continue;
      const described = describeAccount(account);
      await logSecurityEvent({ type: "settlement.activated", actor: { type: "system", name: "LinkPay" }, business: business._id, summary: `${described} is ready for withdrawals` });
      await notifyUsers(
        (await securityContacts(business)).userIds,
        { type: "security.settlement_active", title: "Settlement account ready", body: `You can now withdraw to ${described}.`, link: PROTECTION_LINK, data: { businessId: String(business._id), settlementAccountId: account.id } },
        business,
      );
      await emailSecurityContacts(business, {
        subject: `Settlement account ready for ${business.name}`,
        intro: `${described} passed LinkPay's review and is ready. You can now withdraw to it.`,
      });
    } else {
      business.set("moneyOut.settlementOnly", { enabled: false, since: undefined, by: undefined });
      await business.save();
      await logSecurityEvent({ type: "settlement_only.disabled", actor: { type: "system", name: "LinkPay" }, business: business._id, summary: "\"Settlement accounts only\" is off" });
      await notifyUsers(
        (await securityContacts(business)).userIds,
        { type: "security.protection_changed", title: "\"Settlement accounts only\" is off", body: `Money can be sent to any bank account from ${business.name} again.`, link: PROTECTION_LINK },
        business,
      );
      await emailSecurityContacts(business, {
        subject: `"Settlement accounts only" is off for ${business.name}`,
        intro: `After LinkPay's review, "settlement accounts only" is off. Money can be sent to any bank account again.`,
      });
    }
  }
  return completed;
}

/** Checks for requests whose cooling-off has ended (not used in tests). */
export function startSecurityRequestProcessor(intervalMs: number) {
  if (intervalMs <= 0) return () => {};
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    completeDueRequests()
      .catch((err) => console.error("Security request check failed:", err))
      .finally(() => {
        running = false;
      });
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
}

// ---------------------------------------------------------------------------------------------------------
// Staff decisions
// ---------------------------------------------------------------------------------------------------------

/**
 * A staff decision on a pending request. Approving needs the reviewer to have called the business back on a
 * number from its verification. The change still waits for the end of the cooling-off.
 */
export async function decideSecurityRequest(
  actor: Actor & { type: "staff" },
  request: SecurityRequestDocument,
  decision: "approved" | "rejected",
  input: { note: string; callbackConfirmed?: boolean },
) {
  if (decision === "approved" && !input.callbackConfirmed) {
    throw new HttpError(400, "Call the business back on a number from its verification before approving.", "CALLBACK_REQUIRED");
  }
  const decided = await SecurityRequestModel.findOneAndUpdate(
    { _id: request._id, status: "pending" },
    {
      status: decision,
      review: { decision, by: actor.staff, byName: actor.name, at: new Date(), note: input.note, callbackConfirmed: !!input.callbackConfirmed },
    },
    { returnDocument: "after" },
  );
  if (!decided) throw new HttpError(409, "This request isn't waiting for review", "REQUEST_NOT_PENDING");
  const business = await BusinessModel.findById(decided.business);
  const account = decided.settlementAccount ? await SettlementAccountModel.findById(decided.settlementAccount) : null;
  const what = account ? `settlement account ${describeAccount(account)}` : "turning off \"settlement accounts only\"";

  await audit(actor, {
    action: decision === "approved" ? "security.request_approved" : "security.request_rejected",
    business: decided.business,
    target: { kind: "security_request", id: decided._id },
    summary: `${decision === "approved" ? "Approved" : "Rejected"} ${what}`,
    details: { note: input.note, callbackConfirmed: !!input.callbackConfirmed, kind: decided.kind },
  });
  const staffActor: SecurityActor = { type: "staff", id: actor.staff, name: "LinkPay" };
  if (decision === "approved") {
    await logSecurityEvent({
      type: "settlement.approved",
      actor: staffActor,
      business: decided.business,
      summary: `LinkPay approved ${what}${decided.availableAt.getTime() > Date.now() ? `; it takes effect at ${decided.availableAt.toUTCString()}` : ""}`,
    });
    await completeDueRequests({ _id: decided._id });
  } else {
    if (account) await SettlementAccountModel.updateOne({ _id: account._id, status: "pending" }, { status: "rejected", endedAt: new Date() });
    await logSecurityEvent({
      type: decided.kind === "settlement_account" ? "settlement.rejected" : "settlement_only.off_rejected",
      actor: staffActor,
      business: decided.business,
      summary: `LinkPay didn't approve ${what}: ${input.note}`,
    });
    if (business) {
      await notifyUsers(
        (await securityContacts(business)).userIds,
        {
          type: "security.settlement_rejected",
          title: account ? "Settlement account not approved" : "Request not approved",
          body: `LinkPay didn't approve ${what}. ${input.note}`,
          link: PROTECTION_LINK,
        },
        business,
      );
      await emailSecurityContacts(business, { subject: `Not approved: ${what}`, intro: `LinkPay didn't approve ${what} for ${business.name}.`, details: [input.note] });
    }
  }
  return (await SecurityRequestModel.findById(decided._id))!;
}

/** Staff clear a person's indefinite hold (after a report) and any code lockout. */
export async function clearUserHold(actor: Actor & { type: "staff" }, userId: Id, note: string) {
  const user = await UserModel.findById(userId).select("name security");
  if (!user) throw new HttpError(404, "User not found");
  await UserModel.updateOne(
    { _id: user._id },
    { $unset: { "security.holdUntil": 1, "security.holdReason": 1, "security.lockedUntil": 1 }, "security.holdIndefinite": false },
  );
  await audit(actor, { action: "user.hold_cleared", target: { kind: "user", id: user._id }, summary: `Cleared the money-out hold on ${user.name}`, details: { note } });
  return user;
}

// ---------------------------------------------------------------------------------------------------------
// "This wasn't me"
// ---------------------------------------------------------------------------------------------------------

async function findReport(token: string) {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) throw new HttpError(404, "This link isn't valid", "REPORT_NOT_FOUND");
  const report = await SecurityReportModel.findOne({ tokenHash: hashReportToken(token) });
  if (!report) throw new HttpError(404, "This link isn't valid", "REPORT_NOT_FOUND");
  return report;
}

const reportStatus = (r: { usedAt?: Date | null; expiresAt: Date }) => (r.usedAt ? "used" : r.expiresAt.getTime() < Date.now() ? "expired" : "open");

/** What the report page shows before the person confirms. Reading it changes nothing (email scanners open links). */
export async function previewReport(token: string) {
  const report = await findReport(token);
  const business = report.business ? await BusinessModel.findById(report.business).select("name") : null;
  return {
    subject: report.subject,
    summary: report.summary,
    businessName: business?.name ?? null,
    createdAt: report.get("createdAt") as Date,
    status: reportStatus(report),
  };
}

/**
 * The person says they didn't make the change: stop it, sign out whoever made it everywhere and hold their
 * money out until staff clear it, freeze money leaving the business, and flag it for the compliance team.
 */
export async function submitReport(token: string, req?: Request) {
  const found = await findReport(token);
  const report = await SecurityReportModel.findOneAndUpdate(
    { _id: found._id, usedAt: null, expiresAt: { $gt: new Date() } },
    { usedAt: new Date() },
    { returnDocument: "after" },
  );
  if (!report) {
    const status = reportStatus(found);
    throw new HttpError(410, status === "used" ? "This report has already been made." : "This link has expired. Contact support.", status === "used" ? "REPORT_USED" : "REPORT_EXPIRED");
  }
  const actor: Extract<SecurityActor, { type: "report" }> = { type: "report", id: report._id, name: report.email };

  // 1. Stop the change, or undo it if it already took effect.
  const request = report.request ? await SecurityRequestModel.findById(report.request) : null;
  if (request?.status === "completed" && request.kind === "settlement_account") {
    await SettlementAccountModel.updateOne({ _id: request.settlementAccount, status: "active" }, { status: "removed", endedAt: new Date() });
  }
  if (request?.status === "completed" && request.kind === "settlement_only_off") {
    await BusinessModel.updateOne({ _id: request.business }, { "moneyOut.settlementOnly": { enabled: true, since: new Date() } });
  }

  // 2. Whoever made it: signed out everywhere (the web too) and held until staff have checked.
  // Rounded up to a whole second: tokens record whole seconds, so this catches one issued a moment ago.
  const signedOutAt = new Date(Math.ceil(Date.now() / 1000) * 1000);
  await UserModel.updateOne(
    { _id: report.user },
    { "security.sessionsValidAfter": signedOutAt, "security.holdIndefinite": true, "security.holdReason": "reported" },
  );
  await revokeOtherSessions(String(report.user));

  // 3. The business: open changes cancelled and money out frozen until staff have spoken to it.
  const business = report.business ? await BusinessModel.findById(report.business) : null;
  if (business) {
    await cancelOpenRequests(business, { by: "report", byId: report._id, byName: report.email, reason: "Reported with \"This wasn't me\"" });
    await freezeMoneyOut(business, actor, `"This wasn't me": ${report.summary}`, req);
    await raiseFlag(
      { type: "system", name: "Security report" },
      {
        business,
        category: "account_security",
        severity: "high",
        summary: `"This wasn't me" report: ${report.summary}`,
        note: `Reported by ${report.email}. The person who made the change was signed out everywhere and can't move money until a staff member clears them.`,
      },
    );
  }
  await logSecurityEvent({
    type: "report.received",
    actor,
    business: business?._id,
    user: report.user,
    summary: `${report.email} reported "${report.summary}" as not them`,
    req,
  });
  await notifyStaff(await staffWith("security.review"), {
    type: "security.reported",
    title: business ? `Reported: ${business.name}` : "Reported two-step change",
    body: `${report.email} says they didn't make this change: ${report.summary}.`,
    link: business ? `/businesses/${business.id}/compliance` : `/users`,
    data: { businessId: business ? business.id : null, userId: String(report.user) },
  });
  return { status: "reported" as const, businessName: business?.name ?? null };
}

// ---------------------------------------------------------------------------------------------------------
// What clients see
// ---------------------------------------------------------------------------------------------------------

export function serializeSettlementAccount(account: SettlementAccountDocument, request?: SecurityRequestDocument | null, addedByName?: string | null) {
  return {
    _id: account.id as string,
    accountNumber: account.accountNumber,
    accountName: account.accountName,
    bankName: account.bankName ?? null,
    status: account.status,
    nameCheck: { result: account.nameCheck!.result, matchedTo: account.nameCheck!.matchedTo, matchedName: account.nameCheck!.matchedName },
    addedBy: addedByName ? { _id: String(account.addedBy), name: addedByName } : null,
    createdAt: account.get("createdAt") as Date,
    activatedAt: account.activatedAt ?? null,
    endedAt: account.endedAt ?? null,
    lastWithdrawalAt: account.lastWithdrawalAt ?? null,
    review: request
      ? {
          status: request.status,
          // Can't be used before this, whatever the review says.
          availableAt: request.availableAt,
          decidedAt: request.review?.at ?? null,
          // Shown to the business only when it wasn't approved.
          note: request.status === "rejected" ? (request.review?.note ?? null) : null,
        }
      : null,
  };
}

/** A request as the business sees it (no reviewer details or risk signals). */
export function serializeRequestForBusiness(request: SecurityRequestDocument) {
  return {
    _id: request.id as string,
    kind: request.kind,
    status: request.status,
    availableAt: request.availableAt,
    createdAt: request.get("createdAt") as Date,
    note: request.status === "rejected" ? (request.review?.note ?? null) : null,
  };
}

export const coolingOffHours = { settlement: HOURS(SECURITY.settlementCoolingOffMs), settlementOnlyOff: HOURS(SECURITY.lockRemovalCoolingOffMs) };
