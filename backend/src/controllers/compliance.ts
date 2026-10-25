import type { RequestHandler } from "express";
import { isValidObjectId, Types } from "mongoose";
import { z } from "zod";
import {
  COMPLIANCE_STATUSES,
  FLAG_CATEGORIES,
  FLAG_CATEGORY_KEYS,
  FLAG_OUTCOMES,
  FLAG_SEVERITIES,
  RISK_RULE_KEYS,
  RISK_RULES,
  type FlagCategory,
  type RiskRule,
} from "../config/compliance";
import { AUDIT_ACTIONS, AuditLogModel } from "../models/AuditLog";
import { BusinessModel, type BusinessDocument } from "../models/Business";
import { ComplianceFlagModel, type ComplianceFlagDocument } from "../models/ComplianceFlag";
import { LinkReportModel } from "../models/PaymentLink";
import { StaffModel } from "../models/Staff";
import { TransactionModel } from "../models/Transaction";
import { TransferModel } from "../models/Transfer";
import { audit, serializeAuditEntry, staffActor } from "../services/audit";
import { banBusiness, complianceStatusOf, raiseFlag, reinstateBusiness, resolveFlag, suspendBusiness, unbanBusiness } from "../services/compliance";
import { runRiskChecks } from "../services/risk";
import { assertNoConflictOfInterest } from "../services/staff";
import { HttpError } from "../utils/HttpError";
import { serializeAdminTransfers } from "./adminActivity";
import { serializeTransactions } from "./transactions";

type IdParams = { id: string };

const objectId = z.string().refine(isValidObjectId, "Invalid id");
const note = z.string().trim().min(1, "Add a note").max(2000);

async function findBusiness(id: string) {
  if (!isValidObjectId(id)) throw new HttpError(400, "Invalid id");
  const business = await BusinessModel.findById(id);
  if (!business) throw new HttpError(404, "Business not found");
  return business;
}

/** A business the signed-in staff member may make a decision about: not one they own or work at. */
async function findDecidableBusiness(staffId: string, id: string) {
  const business = await findBusiness(id);
  await assertNoConflictOfInterest(staffId, business);
  return business;
}

async function findFlag(id: string) {
  if (!isValidObjectId(id)) throw new HttpError(400, "Invalid id");
  const flag = await ComplianceFlagModel.findById(id);
  if (!flag) throw new HttpError(404, "Flag not found", "FLAG_NOT_FOUND");
  return flag;
}

async function staffNames(ids: (Types.ObjectId | null | undefined)[]) {
  const unique = [...new Set(ids.filter(Boolean).map(String))];
  const staff = unique.length ? await StaffModel.find({ _id: { $in: unique } }).select("name") : [];
  return new Map(staff.map((s) => [s.id as string, { _id: s.id as string, name: s.name }]));
}

async function serializeFlags(flags: ComplianceFlagDocument[]) {
  const [staff, businesses] = await Promise.all([
    staffNames(flags.flatMap((f) => [f.raisedBy, f.resolution?.by])),
    BusinessModel.find({ _id: { $in: flags.map((f) => f.business) } }).select("name status compliance.status"),
  ]);
  return flags.map((f) => {
    const b = businesses.find((x) => x._id.equals(f.business));
    return {
      _id: f.id as string,
      business: b ? { _id: b.id as string, name: b.name, status: b.status, compliance: complianceStatusOf(b) } : { _id: String(f.business) },
      source: f.source,
      rule: f.rule ?? null,
      ruleLabel: f.rule ? RISK_RULES[f.rule as RiskRule].label : null,
      category: f.category,
      categoryLabel: FLAG_CATEGORIES[f.category as FlagCategory],
      severity: f.severity,
      summary: f.summary,
      note: f.note ?? null,
      evidence: {
        transactions: (f.evidence?.transactions ?? []).map(String),
        transfers: (f.evidence?.transfers ?? []).map(String),
        metrics: (f.evidence?.metrics ?? {}) as Record<string, unknown>,
      },
      status: f.status,
      raisedBy: f.raisedBy ? (staff.get(String(f.raisedBy)) ?? null) : null,
      resolution:
        f.status === "resolved"
          ? {
              outcome: f.resolution?.outcome ?? null,
              note: f.resolution?.note ?? null,
              by: f.resolution?.by ? (staff.get(String(f.resolution.by)) ?? null) : null,
              at: f.resolution?.at ?? null,
            }
          : null,
      createdAt: f.get("createdAt") as Date,
      updatedAt: f.get("updatedAt") as Date,
    };
  });
}

/** The business's compliance state as staff see it. */
async function complianceState(business: BusinessDocument) {
  const by = business.compliance?.by ? (await staffNames([business.compliance.by])).get(String(business.compliance.by)) : null;
  const status = complianceStatusOf(business);
  return {
    status,
    reason: status === "active" ? null : (business.compliance?.reason ?? null),
    reasonLabel: status !== "active" && business.compliance?.reason ? FLAG_CATEGORIES[business.compliance.reason as FlagCategory] : null,
    note: status === "active" ? null : (business.compliance?.note ?? null),
    since: status === "active" ? null : (business.compliance?.since ?? null),
    by: status === "active" ? null : (by ?? null),
    openFlags: business.compliance?.openFlags ?? 0,
    highestOpenSeverity: business.compliance?.highestOpenSeverity ?? null,
    lastFlaggedAt: business.compliance?.lastFlaggedAt ?? null,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Overview, rules, flags
// ---------------------------------------------------------------------------------------------------------

/** Tiles for the compliance page. */
export const getComplianceSummary: RequestHandler = async (_req, res) => {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const [bySeverity, bySource, restricted, flagged, raisedLast7d, resolvedLast7d, openLinkReports] = await Promise.all([
    ComplianceFlagModel.aggregate<{ _id: string; count: number }>([{ $match: { status: "open" } }, { $group: { _id: "$severity", count: { $sum: 1 } } }]),
    ComplianceFlagModel.aggregate<{ _id: string; count: number }>([{ $match: { status: "open" } }, { $group: { _id: "$source", count: { $sum: 1 } } }]),
    BusinessModel.aggregate<{ _id: string; count: number }>([
      { $match: { "compliance.status": { $in: ["suspended", "banned"] } } },
      { $group: { _id: "$compliance.status", count: { $sum: 1 } } },
    ]),
    BusinessModel.countDocuments({ "compliance.openFlags": { $gt: 0 } }),
    ComplianceFlagModel.countDocuments({ createdAt: { $gte: weekAgo } }),
    ComplianceFlagModel.countDocuments({ "resolution.at": { $gte: weekAgo } }),
    LinkReportModel.countDocuments({ status: "open" }),
  ]);
  const count = (rows: { _id: string; count: number }[], key: string) => rows.find((r) => r._id === key)?.count ?? 0;
  res.json({
    openFlags: {
      total: bySeverity.reduce((s, r) => s + r.count, 0),
      high: count(bySeverity, "high"),
      medium: count(bySeverity, "medium"),
      low: count(bySeverity, "low"),
      fromRules: count(bySource, "rule"),
      fromStaff: count(bySource, "staff"),
    },
    flaggedBusinesses: flagged,
    suspended: count(restricted, "suspended"),
    banned: count(restricted, "banned"),
    raisedLast7d,
    resolvedLast7d,
    // Reports about payment links from the public, waiting for review.
    openLinkReports,
  });
};

/** The automatic rules with their thresholds, and the lists the forms need. */
export const getComplianceRules: RequestHandler = async (_req, res) => {
  res.json({
    rules: RISK_RULE_KEYS.map((key) => ({ key, ...RISK_RULES[key] })),
    categories: FLAG_CATEGORY_KEYS.map((key) => ({ key, label: FLAG_CATEGORIES[key] })),
    severities: FLAG_SEVERITIES,
    statuses: COMPLIANCE_STATUSES,
  });
};

/** `?status=open|resolved|all&severity=&category=&rule=&source=&business=&skip=&take=`. Open flags: highest severity first. */
export const listFlags: RequestHandler = async (req, res) => {
  const query = z
    .object({
      status: z.enum(["open", "resolved", "all"]).default("open"),
      severity: z.enum(FLAG_SEVERITIES).optional(),
      category: z.enum(FLAG_CATEGORY_KEYS).optional(),
      rule: z.enum(RISK_RULE_KEYS).optional(),
      source: z.enum(["rule", "staff"]).optional(),
      business: objectId.optional(),
      skip: z.coerce.number().int().min(0).default(0),
      take: z.coerce.number().int().min(1).max(100).default(25),
    })
    .parse(req.query);
  const filter: Record<string, unknown> = {};
  if (query.status !== "all") filter.status = query.status;
  for (const key of ["severity", "category", "rule", "source"] as const) if (query[key]) filter[key] = query[key];
  if (query.business) filter.business = new Types.ObjectId(query.business);

  // Severity as a number so high sorts first, then newest.
  const rank = { $switch: { branches: [{ case: { $eq: ["$severity", "high"] }, then: 3 }, { case: { $eq: ["$severity", "medium"] }, then: 2 }], default: 1 } };
  const [ids, total] = await Promise.all([
    ComplianceFlagModel.aggregate<{ _id: Types.ObjectId }>([
      { $match: filter },
      { $addFields: { rank: query.status === "open" ? rank : 0 } },
      { $sort: { rank: -1, createdAt: -1, _id: -1 } },
      { $skip: query.skip },
      { $limit: query.take },
      { $project: { _id: 1 } },
    ]),
    ComplianceFlagModel.countDocuments(filter),
  ]);
  const flags = await ComplianceFlagModel.find({ _id: { $in: ids.map((i) => i._id) } });
  const ordered = ids.map((i) => flags.find((f) => f._id.equals(i._id))!).filter(Boolean);
  res.json({ items: await serializeFlags(ordered), total, skip: query.skip, take: query.take });
};

/** One flag with the payments and transfers behind it. */
export const getFlag: RequestHandler<IdParams> = async (req, res) => {
  const flag = await findFlag(req.params.id);
  const [serialized] = await serializeFlags([flag]);
  const [transactions, transfers] = await Promise.all([
    TransactionModel.find({ _id: { $in: flag.evidence?.transactions ?? [] } }).sort({ occurredAt: -1 }),
    TransferModel.find({ _id: { $in: flag.evidence?.transfers ?? [] } }).sort({ createdAt: -1 }),
  ]);
  res.json({
    ...serialized,
    evidence: {
      ...serialized!.evidence,
      transactions: await serializeTransactions(transactions),
      transfers: await serializeAdminTransfers(transfers),
    },
  });
};

export const createFlag: RequestHandler<IdParams> = async (req, res) => {
  const body = z
    .object({
      category: z.enum(FLAG_CATEGORY_KEYS),
      severity: z.enum(FLAG_SEVERITIES),
      summary: z.string().trim().min(3).max(200),
      note: z.string().trim().max(2000).optional(),
      transactionIds: z.array(objectId).max(50).default([]),
      transferIds: z.array(objectId).max(50).default([]),
    })
    .parse(req.body);
  const business = await findDecidableBusiness(req.staffId!, req.params.id);
  // Evidence must belong to this business.
  const [transactions, transfers] = await Promise.all([
    TransactionModel.find({ _id: { $in: body.transactionIds }, business: business._id }).select("_id"),
    TransferModel.find({ _id: { $in: body.transferIds }, business: business._id }).select("_id"),
  ]);
  if (transactions.length !== new Set(body.transactionIds).size || transfers.length !== new Set(body.transferIds).size) {
    throw new HttpError(400, "Some of the payments or transfers don't belong to this business", "INVALID_EVIDENCE");
  }
  const flag = await raiseFlag(await staffActor(req), {
    business,
    category: body.category,
    severity: body.severity,
    summary: body.summary,
    note: body.note,
    evidence: { transactions: transactions.map((t) => t._id), transfers: transfers.map((t) => t._id) },
  });
  res.status(201).json((await serializeFlags([flag!]))[0]);
};

export const resolveFlagHandler: RequestHandler<IdParams> = async (req, res) => {
  const body = z.object({ outcome: z.enum(FLAG_OUTCOMES), note }).parse(req.body);
  const flag = await findFlag(req.params.id);
  const business = await BusinessModel.findById(flag.business).select("owner");
  if (business) await assertNoConflictOfInterest(req.staffId!, business);
  const resolved = await resolveFlag(await staffActor(req), flag, body.outcome, body.note);
  res.json((await serializeFlags([resolved]))[0]);
};

/** Runs the automatic rules now (they also run every few minutes). */
export const runChecks: RequestHandler = async (_req, res) => {
  res.json(await runRiskChecks());
};

// ---------------------------------------------------------------------------------------------------------
// One business
// ---------------------------------------------------------------------------------------------------------

/** State, every flag (newest first) and the latest timeline entries. Older timeline entries: GET /audit?business=. */
export const getBusinessCompliance: RequestHandler<IdParams> = async (req, res) => {
  const business = await findBusiness(req.params.id);
  const [flags, timeline] = await Promise.all([
    ComplianceFlagModel.find({ business: business._id }).sort({ createdAt: -1 }).limit(100),
    AuditLogModel.find({ business: business._id }).sort({ _id: -1 }).limit(51),
  ]);
  res.json({
    business: { _id: business.id, name: business.name, status: business.status },
    compliance: await complianceState(business),
    flags: await serializeFlags(flags),
    timeline: timeline.slice(0, 50).map(serializeAuditEntry),
    timelineNextBefore: timeline.length > 50 ? timeline[49]!.id : null,
  });
};

export const addNote: RequestHandler<IdParams> = async (req, res) => {
  const body = z.object({ body: note }).parse(req.body);
  // A note is on the business's compliance record, so it's a decision like a flag: not by its own people.
  const business = await findDecidableBusiness(req.staffId!, req.params.id);
  const entry = await audit(await staffActor(req), {
    action: "note.added",
    business: business._id,
    target: { kind: "business", id: business._id },
    summary: body.body,
  });
  res.status(201).json(serializeAuditEntry(entry));
};

const restriction = z.object({ reason: z.enum(FLAG_CATEGORY_KEYS), note });
const liftNote = z.object({ note });

const respondWithState = async (res: Parameters<RequestHandler>[1], business: BusinessDocument) =>
  res.json({ business: { _id: business.id, name: business.name, status: business.status }, compliance: await complianceState(business) });

export const suspend: RequestHandler<IdParams> = async (req, res) => {
  const body = restriction.parse(req.body);
  const business = await findDecidableBusiness(req.staffId!, req.params.id);
  await respondWithState(res, await suspendBusiness(await staffActor(req), business, body));
};

export const reinstate: RequestHandler<IdParams> = async (req, res) => {
  const body = liftNote.parse(req.body);
  const business = await findDecidableBusiness(req.staffId!, req.params.id);
  await respondWithState(res, await reinstateBusiness(await staffActor(req), business, body.note));
};

export const ban: RequestHandler<IdParams> = async (req, res) => {
  const body = restriction.parse(req.body);
  const business = await findDecidableBusiness(req.staffId!, req.params.id);
  await respondWithState(res, await banBusiness(await staffActor(req), business, body));
};

export const unban: RequestHandler<IdParams> = async (req, res) => {
  const body = liftNote.parse(req.body);
  const business = await findDecidableBusiness(req.staffId!, req.params.id);
  await respondWithState(res, await unbanBusiness(await staffActor(req), business, body.note));
};

// ---------------------------------------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------------------------------------

/** Newest first, paged with `before` (an entry id). `?business=&staff=&action=&before=&take=`. */
export const listAuditLog: RequestHandler = async (req, res) => {
  const query = z
    .object({
      business: objectId.optional(),
      staff: objectId.optional(),
      action: z.enum(AUDIT_ACTIONS).optional(),
      before: objectId.optional(),
      take: z.coerce.number().int().min(1).max(100).default(50),
    })
    .parse(req.query);
  const filter: Record<string, unknown> = {};
  if (query.business) filter.business = new Types.ObjectId(query.business);
  if (query.staff) filter["actor.staff"] = new Types.ObjectId(query.staff);
  if (query.action) filter.action = query.action;
  if (query.before) filter._id = { $lt: new Types.ObjectId(query.before) };
  const entries = await AuditLogModel.find(filter).sort({ _id: -1 }).limit(query.take + 1);
  const page = entries.slice(0, query.take);
  const businesses = await BusinessModel.find({ _id: { $in: page.map((e) => e.business).filter(Boolean) } }).select("name");
  res.json({
    items: page.map((e) => ({
      ...serializeAuditEntry(e),
      business: e.business ? { _id: String(e.business), name: businesses.find((b) => b._id.equals(e.business!))?.name ?? null } : null,
    })),
    nextBefore: entries.length > query.take ? page.at(-1)!.id : null,
  });
};
