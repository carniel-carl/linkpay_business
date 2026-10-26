import type { RequestHandler } from "express";
import { isValidObjectId, Types } from "mongoose";
import { z } from "zod";
import { BusinessModel } from "../models/Business";
import { SecurityEventModel } from "../models/SecurityEvent";
import {
  OPEN_REQUEST_STATUSES,
  SECURITY_REQUEST_KINDS,
  SECURITY_REQUEST_STATUSES,
  SecurityRequestModel,
  type SecurityRequestDocument,
} from "../models/SecurityRequest";
import { SettlementAccountModel, type SettlementAccountDocument } from "../models/SettlementAccount";
import { UserModel } from "../models/User";
import { audit, staffActor } from "../services/audit";
import { freezeMoneyOut, unfreezeMoneyOut } from "../services/moneyOut";
import { serializeSecurityEvent } from "../services/securityEvents";
import { clearUserHold, completeDueRequests, decideSecurityRequest } from "../services/settlement";
import { HttpError } from "../utils/HttpError";

type IdParams = { id: string };

const objectId = z.string().refine(isValidObjectId, "Invalid id");
const note = z.string().trim().min(3, "Add a note").max(1000);

function serializeAccount(a: SettlementAccountDocument) {
  return {
    _id: a.id as string,
    accountNumber: a.accountNumber,
    accountName: a.accountName,
    bankName: a.bankName ?? null,
    status: a.status,
    nameCheck: a.nameCheck,
    createdAt: a.get("createdAt") as Date,
    activatedAt: a.activatedAt ?? null,
    endedAt: a.endedAt ?? null,
    lastWithdrawalAt: a.lastWithdrawalAt ?? null,
  };
}

/** Requests with their business, account and requester filled in. */
async function serializeRequests(requests: SecurityRequestDocument[]) {
  const [businesses, accounts, users] = await Promise.all([
    BusinessModel.find({ _id: { $in: requests.map((r) => r.business) } }).select("name type moneyOut.frozen.at"),
    SettlementAccountModel.find({ _id: { $in: requests.map((r) => r.settlementAccount).filter(Boolean) } }),
    UserModel.find({ _id: { $in: requests.map((r) => r.requestedBy) } }).select("name email"),
  ]);
  return requests.map((r) => {
    const b = businesses.find((x) => x._id.equals(r.business));
    const a = r.settlementAccount ? accounts.find((x) => x._id.equals(r.settlementAccount!)) : null;
    const u = users.find((x) => x._id.equals(r.requestedBy));
    return {
      _id: r.id as string,
      kind: r.kind,
      status: r.status,
      business: b ? { _id: b.id as string, name: b.name, type: b.type, frozen: !!b.moneyOut?.frozen?.at } : null,
      settlementAccount: a ? serializeAccount(a) : null,
      requestedBy: u ? { _id: u.id as string, name: u.name, email: u.email } : null,
      ip: r.ip ?? null,
      userAgent: r.userAgent ?? null,
      availableAt: r.availableAt,
      createdAt: r.get("createdAt") as Date,
      completedAt: r.completedAt ?? null,
      signals: r.signals ?? {},
      review: r.review?.decision ? r.review : null,
      cancellation: r.cancellation?.by ? r.cancellation : null,
    };
  });
}

async function findRequest(id: string) {
  if (!isValidObjectId(id)) throw new HttpError(400, "Invalid id");
  const request = await SecurityRequestModel.findById(id);
  if (!request) throw new HttpError(404, "Request not found", "REQUEST_NOT_FOUND");
  return request;
}

async function findBusiness(id: string) {
  if (!isValidObjectId(id)) throw new HttpError(400, "Invalid id");
  const business = await BusinessModel.findById(id);
  if (!business) throw new HttpError(404, "Business not found");
  return business;
}

/** Counts for the console: waiting for review, approved and cooling off, frozen businesses, reports this month. */
export const getSecuritySummary: RequestHandler = async (_req, res) => {
  await completeDueRequests();
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [pending, coolingOff, frozen, reports] = await Promise.all([
    SecurityRequestModel.countDocuments({ status: "pending" }),
    SecurityRequestModel.countDocuments({ status: "approved" }),
    BusinessModel.countDocuments({ "moneyOut.frozen.at": { $exists: true, $ne: null } }),
    SecurityEventModel.countDocuments({ type: "report.received", createdAt: { $gte: since } }),
  ]);
  res.json({ pending, coolingOff, frozen, reports30d: reports });
};

/** `?status=pending|approved|completed|rejected|cancelled|open&kind=&business=&skip=&take=`. Oldest first while waiting. */
export const listSecurityRequests: RequestHandler = async (req, res) => {
  const q = z
    .object({
      status: z.enum([...SECURITY_REQUEST_STATUSES, "open"]).default("pending"),
      kind: z.enum(SECURITY_REQUEST_KINDS).optional(),
      business: objectId.optional(),
      skip: z.coerce.number().int().min(0).default(0),
      take: z.coerce.number().int().min(1).max(100).default(30),
    })
    .parse(req.query);
  await completeDueRequests();
  const filter: Record<string, unknown> = { status: q.status === "open" ? { $in: OPEN_REQUEST_STATUSES } : q.status };
  if (q.kind) filter.kind = q.kind;
  if (q.business) filter.business = new Types.ObjectId(q.business);
  const waiting = q.status === "pending" || q.status === "open";
  const [items, total] = await Promise.all([
    SecurityRequestModel.find(filter).sort({ createdAt: waiting ? 1 : -1 }).skip(q.skip).limit(q.take),
    SecurityRequestModel.countDocuments(filter),
  ]);
  res.json({ items: await serializeRequests(items), total, skip: q.skip, take: q.take });
};

/**
 * One request with what the reviewer needs: the phone numbers and emails from the business's verification
 * (call back on these, never on a number the requester gives), its other settlement accounts, and recent
 * security activity.
 */
export const getSecurityRequest: RequestHandler<IdParams> = async (req, res) => {
  const request = await findRequest(req.params.id);
  const [serialized] = await serializeRequests([request]);
  const business = await BusinessModel.findById(request.business);
  const [accounts, events] = await Promise.all([
    SettlementAccountModel.find({ business: request.business }).sort({ createdAt: -1 }).limit(20),
    SecurityEventModel.find({ business: request.business }).sort({ createdAt: -1 }).limit(30),
  ]);
  res.json({
    ...serialized,
    contacts: business
      ? {
          businessEmail: business.email ?? null,
          businessPhone: business.phone ?? null,
          people: (business.people ?? []).map((p) => ({ fullName: p.fullName, roles: p.roles, phone: p.phone ?? null, email: p.email ?? null })),
        }
      : null,
    settlementAccounts: accounts.map(serializeAccount),
    events: events.map(serializeSecurityEvent),
  });
};

/** `{ note, callbackConfirmed: true }`. Takes effect at the end of the cooling-off. */
export const approveSecurityRequest: RequestHandler<IdParams> = async (req, res) => {
  const body = z.object({ note, callbackConfirmed: z.boolean() }).parse(req.body);
  const request = await findRequest(req.params.id);
  const decided = await decideSecurityRequest(await staffActor(req), request, "approved", body);
  res.json((await serializeRequests([decided]))[0]);
};

/** `{ note }`: the reason, shown to the business. */
export const rejectSecurityRequest: RequestHandler<IdParams> = async (req, res) => {
  const body = z.object({ note }).parse(req.body);
  const request = await findRequest(req.params.id);
  const decided = await decideSecurityRequest(await staffActor(req), request, "rejected", body);
  res.json((await serializeRequests([decided]))[0]);
};

/** A business's money-out protection, settlement accounts, requests and security activity. */
export const getBusinessSecurity: RequestHandler<IdParams> = async (req, res) => {
  const business = await findBusiness(req.params.id);
  await completeDueRequests({ business: business._id });
  const [accounts, requests, events] = await Promise.all([
    SettlementAccountModel.find({ business: business._id }).sort({ createdAt: -1 }).limit(50),
    SecurityRequestModel.find({ business: business._id }).sort({ createdAt: -1 }).limit(30),
    SecurityEventModel.find({ business: business._id }).sort({ createdAt: -1 }).limit(50),
  ]);
  const frozen = business.moneyOut?.frozen;
  res.json({
    moneyOut: {
      frozen: frozen?.at ? { at: frozen.at, source: frozen.source, byName: frozen.byName ?? null, reason: frozen.reason ?? null } : null,
      settlementOnly: { enabled: !!business.moneyOut?.settlementOnly?.enabled, since: business.moneyOut?.settlementOnly?.since ?? null },
    },
    settlementAccounts: accounts.map(serializeAccount),
    requests: await serializeRequests(requests),
    events: events.map(serializeSecurityEvent),
  });
};

export const freezeBusinessMoneyOut: RequestHandler<IdParams> = async (req, res) => {
  const body = z.object({ reason: note }).parse(req.body);
  const business = await findBusiness(req.params.id);
  const actor = await staffActor(req);
  await freezeMoneyOut(business, { type: "staff", id: actor.staff, name: actor.name }, body.reason, req);
  await audit(actor, { action: "money_out.frozen", business: business._id, target: { kind: "business", id: business._id }, summary: `Froze money out: ${body.reason}`, details: { reason: body.reason } });
  res.status(204).end();
};

/** Lifts any freeze, including a member's or a report's (after speaking to the business). */
export const unfreezeBusinessMoneyOut: RequestHandler<IdParams> = async (req, res) => {
  const body = z.object({ note }).parse(req.body);
  const business = await findBusiness(req.params.id);
  const actor = await staffActor(req);
  await unfreezeMoneyOut(business, { type: "staff", id: actor.staff, name: actor.name }, req);
  await audit(actor, { action: "money_out.unfrozen", business: business._id, target: { kind: "business", id: business._id }, summary: `Unfroze money out: ${body.note}`, details: { note: body.note } });
  res.status(204).end();
};

/** Clears a person's hold after a report (or a code lockout) once staff have checked them. */
export const clearUserHoldHandler: RequestHandler<IdParams> = async (req, res) => {
  const body = z.object({ note }).parse(req.body);
  if (!isValidObjectId(req.params.id)) throw new HttpError(400, "Invalid id");
  await clearUserHold(await staffActor(req), req.params.id, body.note);
  res.status(204).end();
};
