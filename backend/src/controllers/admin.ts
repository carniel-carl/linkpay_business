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
} as const;

function escapeRegex(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const listBusinesses: RequestHandler = async (req, res) => {
  const query = z
    .object({
      status: z.enum(BUSINESS_STATUSES).optional(),
      account: z.enum(["not_started", "pending", "active", "failed"]).optional(),
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

/** Counts per status, plus approved businesses whose bank account setup failed. */
export const getSummary: RequestHandler = async (_req, res) => {
  const [byStatus, accountSetupFailed] = await Promise.all([
    BusinessModel.aggregate<{ _id: string; count: number }>([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
    BusinessModel.countDocuments({ status: "approved", "liquifia.accountStatus": "failed" }),
  ]);
  const counts = Object.fromEntries(BUSINESS_STATUSES.map((s) => [s, 0])) as Record<string, number>;
  for (const { _id, count } of byStatus) counts[_id] = count;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  res.json({ counts, total, accountSetupFailed });
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

  business.set({ status: "approved", reviewedAt: new Date(), reviewedBy: req.userId, reviewNote: undefined });
  await business.save();
  await KybDocumentModel.updateMany({ business: business._id }, { status: "accepted", $unset: { rejectionReason: 1 } });

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
  const account = await provisionBusinessAccount(business._id);
  res.json(account);
};

export const retryBranchAccountProvisioning: RequestHandler<BranchParams> = async (req, res) => {
  const business = await findBusiness(req.params.id);
  if (business.status !== "approved") {
    throw new HttpError(409, "Only approved businesses get an account", "NOT_APPROVED");
  }
  const branch = await findBranch(business._id, req.params.branchId);
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

  business.set({ status: "changes_requested", reviewNote: body.note, reviewedAt: new Date(), reviewedBy: req.userId });
  await business.save();

  const email = await ownerEmail(business.owner);
  if (email) await sendBusinessChangesRequestedEmail(email, business.name, body.note);
  await sendBusinessOverview(res, business, { audience: "admin" });
};

export const rejectBusiness: RequestHandler<IdParams> = async (req, res) => {
  const body = z.object({ reason: z.string().trim().min(1) }).parse(req.body);
  const business = await findSubmittedBusiness(req.params.id);

  business.set({ status: "rejected", reviewNote: body.reason, reviewedAt: new Date(), reviewedBy: req.userId });
  await business.save();

  const email = await ownerEmail(business.owner);
  if (email) await sendBusinessRejectedEmail(email, business.name, body.reason);
  await sendBusinessOverview(res, business, { audience: "admin" });
};

/** Pulls incoming transfers from Liquifia now (normally done every minute in the background). */
export const syncTransactions: RequestHandler = async (_req, res) => {
  res.json(await syncInboundTransfers());
};
