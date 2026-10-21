import type { RequestHandler } from "express";
import { isValidObjectId } from "mongoose";
import { z } from "zod";
import { BUSINESS_STATUSES, BusinessModel } from "../models/Business";
import { KybDocumentModel } from "../models/KybDocument";
import { UserModel } from "../models/User";
import {
  sendBusinessApprovedEmail,
  sendBusinessChangesRequestedEmail,
  sendBusinessRejectedEmail,
} from "../services/email";
import { provisionBranchAccount, provisionBusinessAccount } from "../services/accounts";
import { audit, staffActor } from "../services/audit";
import { kybDecided } from "../services/notificationEvents";
import { syncInboundTransfers } from "../services/transactions";
import { HttpError } from "../utils/HttpError";
import { findBranch } from "./branches";
import { sendBusinessOverview, streamDocument } from "./business";

type IdParams = { id: string };
type DocParams = IdParams & { documentId: string };
type BranchParams = IdParams & { branchId: string };

async function findBusiness(id: string) {
  if (!isValidObjectId(id)) throw new HttpError(400, "Invalid id");
  const business = await BusinessModel.findById(id);
  if (!business) throw new HttpError(404, "Business not found");
  return business;
}

async function findSubmittedBusiness(id: string) {
  const business = await findBusiness(id);
  if (business.compliance?.status === "banned") {
    throw new HttpError(409, "This business is closed (banned). Lift the ban before reviewing it.", "BUSINESS_BANNED");
  }
  if (business.status !== "submitted") {
    throw new HttpError(409, `Only submitted businesses can be reviewed (current: ${business.status})`, "NOT_REVIEWABLE");
  }
  return business;
}

async function ownerEmail(ownerId: unknown) {
  return (await UserModel.findById(ownerId).select("email"))?.email;
}

const SORTS = {
  submitted: "submittedAt",
  created: "createdAt",
  name: "name",
  // Most open flags first with dir=desc.
  flags: "compliance.openFlags",
} as const;

function escapeRegex(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const listBusinesses: RequestHandler = async (req, res) => {
  const query = z
    .object({
      status: z.enum(BUSINESS_STATUSES).optional(),
      account: z.enum(["not_started", "pending", "active", "failed"]).optional(),
      // flagged = has open risk flags; the others are the compliance status.
      compliance: z.enum(["active", "suspended", "banned", "flagged"]).optional(),
      // Matches the business name, RC/BN number or email, or the owner's name or email.
      q: z.string().trim().max(100).optional(),
      sort: z.enum(Object.keys(SORTS) as [keyof typeof SORTS]).default("submitted"),
      dir: z.enum(["asc", "desc"]).default("asc"),
      skip: z.coerce.number().int().min(0).default(0),
      take: z.coerce.number().int().min(1).max(100).default(20),
    })
    .parse(req.query);

  const filter: Record<string, unknown> = query.status ? { status: query.status } : {};
  if (query.account) filter["liquifia.accountStatus"] = query.account;
  if (query.compliance === "flagged") filter["compliance.openFlags"] = { $gt: 0 };
  else if (query.compliance === "active") filter["compliance.status"] = { $in: ["active", null] };
  else if (query.compliance) filter["compliance.status"] = query.compliance;
  if (query.q) {
    const pattern = new RegExp(escapeRegex(query.q), "i");
    const owners = await UserModel.find({ $or: [{ name: pattern }, { email: pattern }] }).select("_id").limit(500);
    filter.$or = [
      { name: pattern },
      { registrationNumber: pattern },
      { email: pattern },
      { owner: { $in: owners.map((o) => o._id) } },
    ];
  }

  const dir = query.dir === "asc" ? 1 : -1;
  // Default: oldest submissions first. _id breaks ties so pages are stable.
  const sort = { [SORTS[query.sort]]: dir, createdAt: dir, _id: dir } as Record<string, 1 | -1>;
  const [items, total] = await Promise.all([
    BusinessModel.find(filter).sort(sort).skip(query.skip).limit(query.take).populate("owner", "name email"),
    BusinessModel.countDocuments(filter),
  ]);
  res.json({ items, total, skip: query.skip, take: query.take });
};

/** Counts per status, approved businesses whose bank account setup failed, and compliance counts. */
export const getSummary: RequestHandler = async (_req, res) => {
  const [byStatus, accountSetupFailed, suspended, banned, flagged] = await Promise.all([
    BusinessModel.aggregate<{ _id: string; count: number }>([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
    BusinessModel.countDocuments({ status: "approved", "liquifia.accountStatus": "failed" }),
    BusinessModel.countDocuments({ "compliance.status": "suspended" }),
    BusinessModel.countDocuments({ "compliance.status": "banned" }),
    BusinessModel.countDocuments({ "compliance.openFlags": { $gt: 0 } }),
  ]);
  const counts = Object.fromEntries(BUSINESS_STATUSES.map((s) => [s, 0])) as Record<string, number>;
  for (const { _id, count } of byStatus) counts[_id] = count;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  res.json({ counts, total, accountSetupFailed, compliance: { flagged, suspended, banned } });
};

export const getBusiness: RequestHandler<IdParams> = async (req, res) => {
  const business = await findBusiness(req.params.id);
  await business.populate("owner", "name email");
  await sendBusinessOverview(res, business, { audience: "admin" });
};

export const downloadBusinessDocument: RequestHandler<DocParams> = async (req, res) => {
  const business = await findBusiness(req.params.id);
  await streamDocument(res, business._id, req.params.documentId);
};

export const approveBusiness: RequestHandler<IdParams> = async (req, res) => {
  const business = await findSubmittedBusiness(req.params.id);

  business.set({ status: "approved", reviewedAt: new Date(), reviewedBy: req.staffId, reviewNote: undefined });
  await business.save();
  await KybDocumentModel.updateMany({ business: business._id }, { status: "accepted", $unset: { rejectionReason: 1 } });
  await kybDecided(business, "approved");
  await audit(await staffActor(req), {
    action: "kyb.approved",
    business: business._id,
    target: { kind: "business", id: business._id },
    summary: "Verification approved",
  });

  // Approval stands even if Liquifia is down; the failure is recorded on the business and an
  // admin can retry with POST /businesses/:id/provision-account.
  const account = await provisionBusinessAccount(business._id).catch((err) => {
    console.error(`Account provisioning failed for business ${business.id}:`, err);
    return undefined;
  });

  const email = await ownerEmail(business.owner);
  if (email) await sendBusinessApprovedEmail(email, business.name, account?.accountNumber);
  await sendBusinessOverview(res, (await BusinessModel.findById(business._id))!, { audience: "admin" });
};

export const retryAccountProvisioning: RequestHandler<IdParams> = async (req, res) => {
  const business = await findBusiness(req.params.id);
  if (business.status !== "approved") {
    throw new HttpError(409, "Only approved businesses get an account", "NOT_APPROVED");
  }
  await audit(await staffActor(req), {
    action: "account.provision_retried",
    business: business._id,
    target: { kind: "business", id: business._id },
    summary: "Retried the head office account setup",
  });
  const account = await provisionBusinessAccount(business._id);
  res.json(account);
};

export const retryBranchAccountProvisioning: RequestHandler<BranchParams> = async (req, res) => {
  const business = await findBusiness(req.params.id);
  if (business.status !== "approved") {
    throw new HttpError(409, "Only approved businesses get an account", "NOT_APPROVED");
  }
  const branch = await findBranch(business._id, req.params.branchId);
  await audit(await staffActor(req), {
    action: "account.provision_retried",
    business: business._id,
    target: { kind: "branch", id: branch._id },
    summary: `Retried the account setup for ${branch.name}`,
  });
  const account = await provisionBranchAccount(branch._id);
  res.json(account);
};

export const requestChanges: RequestHandler<IdParams> = async (req, res) => {
  const body = z
    .object({
      note: z.string().trim().min(1),
      documents: z.array(z.object({ id: z.string(), reason: z.string().trim().min(1) })).default([]),
    })
    .parse(req.body);
  const business = await findSubmittedBusiness(req.params.id);

  for (const { id, reason } of body.documents) {
    const updated = await KybDocumentModel.findOneAndUpdate(
      { _id: id, business: business._id },
      { status: "rejected", rejectionReason: reason },
    );
    if (!updated) throw new HttpError(400, `Document ${id} does not belong to this business`);
  }

  business.set({ status: "changes_requested", reviewNote: body.note, reviewedAt: new Date(), reviewedBy: req.staffId });
  await business.save();

  const email = await ownerEmail(business.owner);
  if (email) await sendBusinessChangesRequestedEmail(email, business.name, body.note);
  await kybDecided(business, "changes_requested", body.note);
  await audit(await staffActor(req), {
    action: "kyb.changes_requested",
    business: business._id,
    target: { kind: "business", id: business._id },
    summary: "Asked for changes to the verification",
    details: { note: body.note, documents: body.documents },
  });
  await sendBusinessOverview(res, business, { audience: "admin" });
};

export const rejectBusiness: RequestHandler<IdParams> = async (req, res) => {
  const body = z.object({ reason: z.string().trim().min(1) }).parse(req.body);
  const business = await findSubmittedBusiness(req.params.id);

  business.set({ status: "rejected", reviewNote: body.reason, reviewedAt: new Date(), reviewedBy: req.staffId });
  await business.save();

  const email = await ownerEmail(business.owner);
  if (email) await sendBusinessRejectedEmail(email, business.name, body.reason);
  await kybDecided(business, "rejected", body.reason);
  await audit(await staffActor(req), {
    action: "kyb.rejected",
    business: business._id,
    target: { kind: "business", id: business._id },
    summary: "Verification rejected",
    details: { reason: body.reason },
  });
  await sendBusinessOverview(res, business, { audience: "admin" });
};

/** Pulls incoming transfers from Liquifia now (normally done every minute in the background). */
export const syncTransactions: RequestHandler = async (_req, res) => {
  res.json(await syncInboundTransfers());
};
