import type { RequestHandler } from "express";
import { z } from "zod";
import { SECURITY, STEP_UP_ACTIONS } from "../config/security";
import { BusinessModel } from "../models/Business";
import { SecurityEventModel } from "../models/SecurityEvent";
import { OPEN_REQUEST_STATUSES, SecurityRequestModel } from "../models/SecurityRequest";
import { UserModel } from "../models/User";
import { enableSettlementOnly, freezeMoneyOut, moneyOutBlocker, unfreezeMoneyOut } from "../services/moneyOut";
import { serializeSecurityEvent, userActor } from "../services/securityEvents";
import {
  cancelSettlementOnlyOff,
  completeDueRequests,
  coolingOffHours,
  previewReport,
  requestSettlementOnlyOff,
  serializeRequestForBusiness,
  submitReport,
} from "../services/settlement";
import { contextOf, requestStepUp, stepUpMethodOf, withStepUp } from "../services/stepUp";
import { hasPermission } from "../services/team";
import { HttpError } from "../utils/HttpError";

/** The business's money-out protection, and what's stopping the signed-in member from moving money (if anything). */
export const getSecurity: RequestHandler = async (req, res) => {
  const business = req.business!;
  await completeDueRequests({ business: business._id });
  const [user, removal] = await Promise.all([
    UserModel.findById(req.userId).select("twoFactor security"),
    SecurityRequestModel.findOne({ business: business._id, kind: "settlement_only_off", status: { $in: OPEN_REQUEST_STATUSES } }),
  ]);
  // Re-read: a request may have just completed.
  const fresh = (await BusinessModel.findById(business._id)) ?? business;
  const frozen = fresh.moneyOut?.frozen;
  const settlementOnly = fresh.moneyOut?.settlementOnly;
  const blocker = moneyOutBlocker(fresh, req.membership!, user);
  // The person's own holds, whatever the business's state (a held owner can't unfreeze either).
  const personal = moneyOutBlocker(null, req.membership!, user);
  const security = user?.security;
  res.json({
    moneyOut: {
      frozen: frozen?.at
        ? {
            at: frozen.at,
            source: frozen.source,
            byName: frozen.source === "member" ? (frozen.byName ?? null) : "LinkPay",
            reason: frozen.source === "member" ? (frozen.reason ?? null) : null,
            // A member's freeze can be lifted by the owner; a report's or staff's only by LinkPay.
            canUnfreeze: frozen.source === "member" && hasPermission(req.membership!, "settlement.manage") && !personal,
          }
        : null,
      settlementOnly: {
        enabled: !!settlementOnly?.enabled,
        since: settlementOnly?.since ?? null,
        removal: removal ? serializeRequestForBusiness(removal) : null,
      },
    },
    me: {
      stepUpMethod: user ? stepUpMethodOf(user) : "email",
      twoFactor: { enabled: !!user?.twoFactor?.enabled, method: user?.twoFactor?.method ?? null },
      hold: security?.holdIndefinite
        ? { until: null, reason: "reported" }
        : security?.holdUntil && security.holdUntil.getTime() > Date.now()
          ? { until: security.holdUntil, reason: security.holdReason ?? "two_factor_changed" }
          : null,
      lockedUntil: security?.lockedUntil && security.lockedUntil.getTime() > Date.now() ? security.lockedUntil : null,
      memberHoldUntil: req.membership!.moneyOutAfter && req.membership!.moneyOutAfter.getTime() > Date.now() ? req.membership!.moneyOutAfter : null,
      // What stops this member moving money now (the first reason), or null.
      blocker: blocker ? { code: blocker.code, message: blocker.message, until: blocker.until } : null,
      // The same, ignoring a freeze: a hold on this person.
      personalBlocker: personal ? { code: personal.code, message: personal.message, until: personal.until } : null,
    },
    rules: {
      settlementCoolingOffHours: coolingOffHours.settlement,
      settlementOnlyOffHours: coolingOffHours.settlementOnlyOff,
      maxSettlementAccounts: SECURITY.maxSettlementAccounts,
      twoFactorHoldHours: Math.round(SECURITY.twoFactorHoldMs / 3_600_000),
      newMemberHoldHours: Math.round(SECURITY.newMemberHoldMs / 3_600_000),
    },
  });
};

/**
 * Starts a step-up: `{ action, request }`, where `request` is the JSON body the action will be sent with
 * (plus `id` for actions on one item). Authenticator users then type their app's code; others get an email.
 */
export const startStepUpHandler: RequestHandler = async (req, res) => {
  const body = z.object({ action: z.enum(STEP_UP_ACTIONS), request: z.record(z.string(), z.unknown()).default({}) }).parse(req.body);
  res.status(201).json(await requestStepUp(contextOf(req), body.action, body.request));
};

/** Emergency stop on all money leaving the business. Any member who handles money can pull it. */
export const freeze: RequestHandler = async (req, res) => {
  const body = z.object({ reason: z.string().trim().max(300).optional() }).parse(req.body ?? {});
  await freezeMoneyOut(req.business!, await userActor(req.userId!), body.reason, req);
  res.status(204).end();
};

/** The owner lifts a freeze a member made (step-up `money_out.unfreeze`). A report's or staff's freeze needs LinkPay. */
export const unfreeze: RequestHandler = async (req, res) => {
  const frozen = req.business!.moneyOut?.frozen;
  if (!frozen?.at) throw new HttpError(409, "Money out isn't frozen", "NOT_FROZEN");
  if (frozen.source !== "member") {
    throw new HttpError(403, "LinkPay froze money out to protect your business. Contact support to have it checked and unfrozen.", "UNFREEZE_NEEDS_SUPPORT");
  }
  await withStepUp(req, "money_out.unfreeze", {}, async () => {
    await unfreezeMoneyOut(req.business!, await userActor(req.userId!), req);
  });
  res.status(204).end();
};

/** Turns on "settlement accounts only" (step-up `settlement_only.enable`). */
export const enableSettlementOnlyHandler: RequestHandler = async (req, res) => {
  await withStepUp(req, "settlement_only.enable", {}, async () => {
    await enableSettlementOnly(req.business!, await userActor(req.userId!), req);
  });
  res.status(204).end();
};

/** Asks to turn "settlement accounts only" off (step-up `settlement_only.disable`): 72 hours and a LinkPay review. */
export const requestSettlementOnlyOffHandler: RequestHandler = async (req, res) => {
  const request = await withStepUp(req, "settlement_only.disable", {}, () => requestSettlementOnlyOff(contextOf(req), req));
  res.status(201).json(serializeRequestForBusiness(request));
};

export const cancelSettlementOnlyOffHandler: RequestHandler = async (req, res) => {
  await cancelSettlementOnlyOff(contextOf(req), req);
  res.status(204).end();
};

/** The business's security activity, newest first. `?before=<iso date>&take=` */
export const listSecurityEvents: RequestHandler = async (req, res) => {
  const q = z.object({ before: z.coerce.date().optional(), take: z.coerce.number().int().min(1).max(100).default(30) }).parse(req.query);
  const items = await SecurityEventModel.find({ business: req.business!._id, ...(q.before && { createdAt: { $lt: q.before } }) })
    .sort({ createdAt: -1 })
    .limit(q.take);
  res.json({ items: items.map(serializeSecurityEvent), nextBefore: items.length === q.take ? items.at(-1)!.get("createdAt") : null });
};

// ---- "This wasn't me" (public) ----

const token = z.string().trim().min(20).max(100);

export const getReport: RequestHandler<{ token: string }> = async (req, res) => {
  res.json(await previewReport(token.parse(req.params.token)));
};

export const postReport: RequestHandler<{ token: string }> = async (req, res) => {
  res.json(await submitReport(token.parse(req.params.token), req));
};
