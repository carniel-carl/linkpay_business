// Step-up authentication (transaction signing). Every action that moves money out, or changes where it can
// go, needs a fresh second-factor code tied to exactly that action and its details (amount, recipient,
// account...). A stolen session alone can't move money, and a code can't be reused for something else.
//
// 1. The client asks for a step-up: POST /api/security/step-up { action, request } (the body it will send).
//    Authenticator users type their app's code; everyone else is emailed a code that says what it's for.
// 2. The client sends the action with headers X-Step-Up-Id and X-Step-Up-Code. The server rebuilds the
//    details from the real request, so a code for ₦5,000 to Ada can't send ₦500,000 to someone else.
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import type { Request } from "express";
import { isValidObjectId, type Types } from "mongoose";
import { z } from "zod";
import { SECURITY, type StepUpAction } from "../config/security";
import type { Permission } from "../config/permissions";
import { BeneficiaryModel } from "../models/Beneficiary";
import { BranchModel } from "../models/Branch";
import type { BusinessDocument } from "../models/Business";
import type { MembershipDocument } from "../models/Membership";
import { PayoutListModel } from "../models/PayoutList";
import { SecurityEventModel } from "../models/SecurityEvent";
import { SettlementAccountModel } from "../models/SettlementAccount";
import { StepUpChallengeModel, type StepUpChallengeDocument } from "../models/StepUpChallenge";
import { TransferBatchModel, TransferModel } from "../models/Transfer";
import { UserModel, type UserDocument } from "../models/User";
import { HttpError } from "../utils/HttpError";
import { formatNaira, sendSecurityEmail, sendStepUpCodeEmail } from "./email";
import { assertMoneyOutAllowed, assertRecipientsAllowed, moneyOutBlocker } from "./moneyOut";
import { logSecurityEvent } from "./securityEvents";
import { hasPermission } from "./team";
import { totpCounter } from "./totp";
import { listBanks } from "./transfers";

type Id = Types.ObjectId | string;
export type StepUpContext = { business: BusinessDocument; membership: MembershipDocument; userId: string };

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** JSON with object keys sorted, so the same details always hash the same. */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, stable((value as Record<string, unknown>)[k])]));
  }
  return value instanceof Date ? value.toISOString() : value;
}

const payloadHash = (ctx: StepUpContext, action: StepUpAction, details: Record<string, unknown>) =>
  sha(JSON.stringify([action, String(ctx.business._id), String(ctx.userId), stable(details)]));

// ---------------------------------------------------------------------------------------------------------
// What each action covers
// ---------------------------------------------------------------------------------------------------------

const objectId = z.string().refine(isValidObjectId, "Invalid id");
const amount = z.number().int().min(1);
const bankRecipient = z.object({ type: z.literal("bank"), accountNumber: z.string().trim(), bankUuid: z.string().trim() });
const recipient = z.discriminatedUnion("type", [
  bankRecipient,
  z.object({ type: z.literal("beneficiary"), beneficiary: objectId }),
  z.object({ type: z.literal("branch"), branch: objectId }),
]);
const row = z.union([
  z.object({ beneficiary: objectId, amountKobo: amount }),
  z.object({ accountNumber: z.string().trim(), bankUuid: z.string().trim(), amountKobo: amount }),
]);
const rowKey = (r: z.infer<typeof row>) => ("beneficiary" in r ? `b:${r.beneficiary}` : `a:${r.accountNumber}:${r.bankUuid}`);

const ACTION_PERMISSION: Record<StepUpAction, Permission> = {
  "transfer.create": "transfers.create",
  "transfer.bulk": "transfers.create",
  "transfer.approve": "transfers.approve",
  "batch.approve": "transfers.approve",
  "payout_list.run": "transfers.create",
  "settlement.add": "settlement.manage",
  "settlement.remove": "settlement.manage",
  "settlement.withdraw": "transfers.create",
  "settlement_only.enable": "settlement.manage",
  "settlement_only.disable": "settlement.manage",
  "money_out.unfreeze": "settlement.manage",
};

type Described = { details: Record<string, unknown>; summary: () => Promise<string> };

async function branchName(ctx: StepUpContext, id: Id | null | undefined) {
  if (!id) return "your account";
  return (await BranchModel.findOne({ _id: id, business: ctx.business._id }).select("name"))?.name ?? "your account";
}
async function bankName(uuid: string) {
  return (await listBanks().catch(() => [])).find((b) => b.uuid === uuid)?.name ?? "bank";
}
const notFound = () => new HttpError(404, "Not found");

/**
 * The details a step-up is tied to, rebuilt the same way from the step-up request and from the real action.
 * `input` is the action's JSON body, plus `id` for actions on one item.
 */
async function describe(action: StepUpAction, ctx: StepUpContext, input: unknown): Promise<Described> {
  const parse = <T extends z.ZodTypeAny>(schema: T): z.infer<T> => {
    const result = schema.safeParse(input ?? {});
    if (!result.success) throw new HttpError(400, "Check the details and try again", "INVALID_STEP_UP");
    return result.data;
  };
  const biz = ctx.business;

  switch (action) {
    case "transfer.create": {
      const b = parse(z.object({ branch: objectId, amountKobo: amount, recipient }));
      const to =
        b.recipient.type === "bank"
          ? { accountNumber: b.recipient.accountNumber, bankUuid: b.recipient.bankUuid }
          : b.recipient.type === "beneficiary"
            ? { beneficiary: b.recipient.beneficiary }
            : { branch: b.recipient.branch };
      return {
        details: { branch: b.branch, amountKobo: b.amountKobo, to },
        summary: async () => {
          let name: string;
          if (b.recipient.type === "bank") name = `${b.recipient.accountNumber} (${await bankName(b.recipient.bankUuid)})`;
          else if (b.recipient.type === "beneficiary") {
            const saved = await BeneficiaryModel.findOne({ _id: b.recipient.beneficiary, business: biz._id });
            name = saved ? `${saved.accountName}, ${saved.accountNumber} (${saved.bankName ?? "bank"})` : "a saved beneficiary";
          } else name = await branchName(ctx, b.recipient.branch);
          return `Send ${formatNaira(b.amountKobo)} from ${await branchName(ctx, b.branch)} to ${name}`;
        },
      };
    }
    case "transfer.bulk": {
      const b = parse(z.object({ branch: objectId, items: z.array(row).min(1).max(500) }));
      const total = b.items.reduce((s, r) => s + r.amountKobo, 0);
      return {
        details: { branch: b.branch, items: b.items.map((r) => [rowKey(r), r.amountKobo]) },
        summary: async () => `Send ${b.items.length} transfers (${formatNaira(total)}) from ${await branchName(ctx, b.branch)}`,
      };
    }
    case "transfer.approve": {
      const b = parse(z.object({ id: objectId }));
      return {
        details: { id: b.id },
        summary: async () => {
          const t = await TransferModel.findOne({ _id: b.id, business: biz._id });
          if (!t) throw notFound();
          return `Approve ${formatNaira(t.amountKobo)} to ${t.recipient!.accountName}, ${t.recipient!.accountNumber}`;
        },
      };
    }
    case "batch.approve": {
      const b = parse(z.object({ id: objectId }));
      return {
        details: { id: b.id },
        summary: async () => {
          const batch = await TransferBatchModel.findOne({ _id: b.id, business: biz._id });
          if (!batch) throw notFound();
          return `Approve ${batch.count} transfers (${formatNaira(batch.amountKobo)})${batch.title ? `: ${batch.title}` : ""}`;
        },
      };
    }
    case "payout_list.run": {
      const b = parse(z.object({ id: objectId, branch: objectId.optional(), items: z.array(row).optional() }));
      const list = await PayoutListModel.findOne({ _id: b.id, business: biz._id });
      if (!list) throw notFound();
      const rows = b.items ?? list.items.map((i) => ({ beneficiary: String(i.beneficiary), amountKobo: i.amountKobo }));
      const total = rows.reduce((s, r) => s + r.amountKobo, 0);
      return {
        // The list's version is included, so a change to the list by someone else voids the code.
        details: { id: b.id, branch: b.branch ?? (list.branch ? String(list.branch) : null), items: rows.map((r) => [rowKey(r), r.amountKobo]), version: list.get("updatedAt") },
        summary: async () => `Pay ${list.title}: ${rows.length} payments (${formatNaira(total)}) from ${await branchName(ctx, b.branch ?? list.branch)}`,
      };
    }
    case "settlement.add": {
      const b = parse(z.object({ accountNumber: z.string().trim(), bankUuid: z.string().trim() }));
      return {
        details: { accountNumber: b.accountNumber, bankUuid: b.bankUuid },
        summary: async () => `Add ${b.accountNumber} (${await bankName(b.bankUuid)}) as a settlement account for ${biz.name}`,
      };
    }
    case "settlement.remove":
    case "settlement.withdraw": {
      const b = parse(
        action === "settlement.remove"
          ? z.object({ id: objectId })
          : z.object({ id: objectId, branch: objectId, amountKobo: amount }),
      ) as { id: string; branch?: string; amountKobo?: number };
      return {
        details: action === "settlement.remove" ? { id: b.id } : { id: b.id, branch: b.branch, amountKobo: b.amountKobo },
        summary: async () => {
          const account = await SettlementAccountModel.findOne({ _id: b.id, business: biz._id });
          if (!account) throw notFound();
          const name = `${account.accountName}, ${account.accountNumber} (${account.bankName ?? "bank"})`;
          return action === "settlement.remove"
            ? `Remove the settlement account ${name}`
            : `Withdraw ${formatNaira(b.amountKobo!)} from ${await branchName(ctx, b.branch)} to ${name}`;
        },
      };
    }
    case "settlement_only.enable":
      return { details: {}, summary: async () => `Turn on "settlement accounts only" for ${biz.name}` };
    case "settlement_only.disable":
      return { details: {}, summary: async () => `Ask to turn off "settlement accounts only" for ${biz.name}` };
    case "money_out.unfreeze":
      return { details: {}, summary: async () => `Unfreeze money leaving ${biz.name}` };
  }
}

/**
 * Refuses early (before a code is sent) when the action couldn't go ahead anyway. Turning on
 * "settlement accounts only" only narrows where money goes, so nothing blocks it; unfreezing is blocked by
 * the person's own holds, not by the freeze itself.
 */
async function assertCanStart(action: StepUpAction, ctx: StepUpContext, input?: unknown) {
  if (!hasPermission(ctx.membership, ACTION_PERMISSION[action])) throw new HttpError(403, "Your role doesn't allow this", "PERMISSION_DENIED");
  if (action === "settlement_only.enable" || action === "settlement.remove") return;
  if (action === "money_out.unfreeze") {
    const user = await UserModel.findById(ctx.userId).select("security");
    const blocker = moneyOutBlocker(null, ctx.membership, user);
    if (blocker) throw new HttpError(423, blocker.message, blocker.code, { until: blocker.until });
    return;
  }
  await assertMoneyOutAllowed(ctx.business, ctx.membership, ctx.userId);
  // "Settlement accounts only": refuse payments to anyone else before asking for a code.
  const toOutsider =
    action === "transfer.bulk" ||
    action === "payout_list.run" ||
    (action === "transfer.create" && (input as { recipient?: { type?: string } } | undefined)?.recipient?.type !== "branch");
  if (toOutsider) await assertRecipientsAllowed(ctx.business, [{ kind: "bank" }]);
}

// ---------------------------------------------------------------------------------------------------------
// Starting and checking a step-up
// ---------------------------------------------------------------------------------------------------------

export const stepUpMethodOf = (user: Pick<UserDocument, "twoFactor">): "totp" | "email" =>
  user.twoFactor?.enabled && user.twoFactor.method === "totp" ? "totp" : "email";

/**
 * Starts a step-up for `action` with the body the client will send. Returns the code for the email method
 * (the caller emails it; tests read it), never to the client.
 */
export async function startStepUp(ctx: StepUpContext, action: StepUpAction, input: unknown) {
  await assertCanStart(action, ctx, input);
  const user = await UserModel.findById(ctx.userId).select("email name twoFactor security");
  if (!user) throw new HttpError(401, "Sign in again", "UNAUTHENTICATED");

  const method = stepUpMethodOf(user);
  const recent =
    method === "email"
      ? await StepUpChallengeModel.find({ user: user._id, method: "email", createdAt: { $gte: new Date(Date.now() - SECURITY.stepUpWindowMs) } })
          .sort({ createdAt: 1 })
          .select("createdAt")
      : [];
  if (recent.length >= SECURITY.stepUpStartLimit) {
    const retryAt = new Date(recent[0]!.get("createdAt").getTime() + SECURITY.stepUpWindowMs);
    throw new HttpError(429, "You've asked for a lot of codes. Wait a few minutes and try again.", "STEP_UP_LIMIT", { retryAt });
  }

  const described = await describe(action, ctx, input);
  const summary = await described.summary();
  const code = method === "email" ? randomInt(0, 1_000_000).toString().padStart(6, "0") : undefined;
  const expiresAt = new Date(Date.now() + SECURITY.stepUpTtlMs);
  const challenge = await StepUpChallengeModel.create({
    user: user._id,
    business: ctx.business._id,
    action,
    payloadHash: payloadHash(ctx, action, described.details),
    summary,
    method,
    codeHash: code ? sha(code) : undefined,
    expiresAt,
    purgeAt: new Date(expiresAt.getTime() + 24 * 60 * 60 * 1000),
  });
  return { challenge, code, email: user.email };
}

/** Starts a step-up and emails the code when needed. What the client is told. */
export async function requestStepUp(ctx: StepUpContext, action: StepUpAction, input: unknown) {
  const { challenge, code, email } = await startStepUp(ctx, action, input);
  if (code) await sendStepUpCodeEmail(email, { summary: challenge.summary, code });
  return { challengeId: challenge.id as string, method: challenge.method, summary: challenge.summary, expiresAt: challenge.expiresAt };
}

/** A wrong code: counts towards the lockout (5 in 15 minutes stops the person moving money for an hour). */
async function recordFailure(user: UserDocument, challenge: StepUpChallengeDocument, req?: Request) {
  await logSecurityEvent({
    type: "step_up.failed",
    actor: { type: "user", id: user._id, name: user.name },
    business: challenge.business,
    summary: `${user.name} entered a wrong code to confirm: ${challenge.summary}`,
    details: { action: challenge.action },
    req,
  });
  const since = new Date(Date.now() - SECURITY.stepUpWindowMs);
  const failures = await SecurityEventModel.countDocuments({ user: user._id, type: "step_up.failed", createdAt: { $gte: since } });
  if (failures < SECURITY.stepUpFailureLimit) return;
  const until = new Date(Date.now() + SECURITY.stepUpLockMs);
  await UserModel.updateOne({ _id: user._id }, { "security.lockedUntil": until });
  await logSecurityEvent({
    type: "step_up.locked",
    actor: { type: "system", name: "LinkPay" },
    business: challenge.business,
    user: user._id,
    summary: `${user.name} can't send money for an hour after ${failures} wrong codes`,
    details: { until },
  });
  await sendSecurityEmail(user.email, {
    subject: "Too many wrong codes",
    intro: `Someone signed in as you entered ${failures} wrong confirmation codes, so you can't send, approve or withdraw money for an hour.`,
    outro: "If this wasn't you, change your password and contact support.",
  }).catch((err) => console.error("Couldn't send the lockout email:", err));
}

const stepUpError = (status: number, message: string, code: string, details?: Record<string, unknown>) => new HttpError(status, message, code, details);

/** Checks and uses up the step-up sent with the request, or throws. Returns it so a failed action can release it. */
async function consumeStepUp(req: Request, ctx: StepUpContext, action: StepUpAction, details: Record<string, unknown>) {
  const id = req.header("x-step-up-id")?.trim();
  const code = req.header("x-step-up-code")?.trim();
  if (!id || !code) throw stepUpError(403, "Confirm this with a code first", "STEP_UP_REQUIRED", { action });
  if (!isValidObjectId(id) || !/^\d{6}$/.test(code)) throw stepUpError(400, "Invalid or expired code", "INVALID_CODE");

  const user = await UserModel.findById(ctx.userId).select("+twoFactor.totpSecret +security.totpLastCounter");
  if (!user) throw new HttpError(401, "Sign in again", "UNAUTHENTICATED");
  if (user.security?.lockedUntil && user.security.lockedUntil.getTime() > Date.now()) {
    throw stepUpError(423, "Too many wrong codes. You can't send money for a while.", "STEP_UP_LOCKED", { until: user.security.lockedUntil });
  }

  const challenge = await StepUpChallengeModel.findOne({ _id: id, user: user._id });
  if (!challenge || challenge.expiresAt.getTime() < Date.now()) throw stepUpError(400, "This code has expired. Ask for a new one.", "STEP_UP_EXPIRED");
  if (challenge.usedAt) throw stepUpError(409, "This code has already been used. Ask for a new one.", "STEP_UP_USED");
  if (challenge.action !== action || challenge.payloadHash !== payloadHash(ctx, action, details)) {
    throw stepUpError(400, "The details changed after you asked for the code. Ask for a new one.", "STEP_UP_MISMATCH");
  }

  if (challenge.verifiedCodeHash) {
    // Retrying a released step-up: the same code that was accepted before.
    if (!timingSafeEqual(Buffer.from(sha(code)), Buffer.from(challenge.verifiedCodeHash))) {
      throw stepUpError(400, "Invalid or expired code", "INVALID_CODE");
    }
  } else {
    if (challenge.attempts >= SECURITY.stepUpMaxAttempts) throw stepUpError(400, "Too many wrong codes. Ask for a new one.", "STEP_UP_EXPIRED");
    let ok = false;
    if (challenge.method === "totp") {
      const secret = user.twoFactor?.totpSecret;
      const counter = secret ? totpCounter(user.email, secret, code) : null;
      // Each authenticator code works once: it must be newer than the last one used.
      if (counter !== null) {
        const claimed = await UserModel.updateOne(
          { _id: user._id, $or: [{ "security.totpLastCounter": { $exists: false } }, { "security.totpLastCounter": null }, { "security.totpLastCounter": { $lt: counter } }] },
          { "security.totpLastCounter": counter },
        );
        ok = claimed.modifiedCount === 1;
      }
    } else {
      ok = !!challenge.codeHash && timingSafeEqual(Buffer.from(sha(code)), Buffer.from(challenge.codeHash));
    }
    if (!ok) {
      await StepUpChallengeModel.updateOne({ _id: challenge._id }, { $inc: { attempts: 1 } });
      await recordFailure(user, challenge, req);
      const attemptsLeft = Math.max(0, SECURITY.stepUpMaxAttempts - challenge.attempts - 1);
      throw stepUpError(400, "Invalid or expired code", "INVALID_CODE", { attemptsLeft });
    }
    challenge.verifiedCodeHash = sha(code);
  }

  const used = await StepUpChallengeModel.findOneAndUpdate(
    { _id: challenge._id, usedAt: null },
    { usedAt: new Date(), verifiedCodeHash: challenge.verifiedCodeHash },
    { returnDocument: "after" },
  );
  if (!used) throw stepUpError(409, "This code has already been used. Ask for a new one.", "STEP_UP_USED");
  return used;
}

/** The business, member and person behind a request (after requireApprovedBusiness). */
export const contextOf = (req: Request): StepUpContext => ({ business: req.business!, membership: req.membership!, userId: req.userId! });

/**
 * Runs `fn` only with a valid step-up for this exact action. If `fn` is refused (not enough money, the
 * account is busy...), the step-up is released so the same request can be retried with the same code.
 * Unexpected errors don't release it: money may already have moved.
 */
export async function withStepUp<T>(req: Request, action: StepUpAction, input: unknown, fn: () => Promise<T>): Promise<T> {
  const ctx = contextOf(req);
  // The real reason first (frozen, on hold...), rather than asking for a code that couldn't help.
  await assertCanStart(action, ctx, input);
  const { details } = await describe(action, ctx, input);
  const challenge = await consumeStepUp(req, ctx, action, details);
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HttpError && err.status < 500) {
      await StepUpChallengeModel.updateOne({ _id: challenge._id, expiresAt: { $gt: new Date() } }, { $unset: { usedAt: 1 } });
    }
    throw err;
  }
}
