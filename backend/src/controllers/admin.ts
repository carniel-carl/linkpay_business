import type { RequestHandler } from "express";
import { isValidObjectId } from "mongoose";
import { z } from "zod";
import { DOCUMENT_TYPES, type DocumentType } from "../config/kyb";
import { AuditLogModel } from "../models/AuditLog";
import { BUSINESS_STATUSES, BusinessModel, type BusinessDocument } from "../models/Business";
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
import { assertNoConflictOfInterest } from "../services/staff";
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

function assertReviewable(business: BusinessDocument) {
  if (business.compliance?.status === "banned") {
    throw new HttpError(409, "This business is closed (banned). Lift the ban before reviewing it.", "BUSINESS_BANNED");
  }
  if (business.status !== "submitted") {
    throw new HttpError(409, `Only submitted businesses can be reviewed (current: ${business.status})`, "NOT_REVIEWABLE");
  }
}

/** A submitted business the signed-in staff member may decide on (not their own). */
async function findSubmittedBusiness(id: string, staffId: string) {
  const business = await findBusiness(id);
  await assertNoConflictOfInterest(staffId, business);
  assertReviewable(business);
  return business;
}

/**
 * Records a review decision, atomically, so two reviewers (or a double click) can't both decide the same
 * submission: only the winner gets the business back, and only the winner should run the side effects.
 */
async function decideSubmittedBusiness(id: string, decision: Record<string, unknown>) {
  if (!isValidObjectId(id)) throw new HttpError(400, "Invalid id");
  const decided = await BusinessModel.findOneAndUpdate(
    { _id: id, status: "submitted", "compliance.status": { $ne: "banned" } },
    decision,
    { returnDocument: "after" },
  );
  if (decided) return decided;
  // Lost (or never reviewable): re-read for the same precise error as before (404, banned, already decided).
  assertReviewable(await findBusiness(id));
  // Only if it was decided and then resubmitted between the update and the re-read.
  throw new HttpError(409, "This business changed while you were reviewing it. Reload and try again.", "NOT_REVIEWABLE");
}

/** Emails the owner about a decision. Best-effort: the decision and its audit entry already stand. */
async function emailOwner(business: BusinessDocument, send: (to: string) => Promise<void>) {
  const email = (await UserModel.findById(business.owner).select("email"))?.email;
  if (email) await send(email).catch((err) => console.error(`Couldn't email the decision on business ${business.id}:`, err));
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

const DOCUMENT_OPEN_WINDOW_MS = 5 * 60_000;

export const downloadBusinessDocument: RequestHandler<DocParams> = async (req, res) => {
  const business = await findBusiness(req.params.id);
  if (!isValidObjectId(req.params.documentId)) throw new HttpError(400, "Invalid id");
  const doc = await KybDocumentModel.findOne({ _id: req.params.documentId, business: business._id }).select("type person");
  if (!doc) throw new HttpError(404, "Document not found");
  // Recorded before the file goes out: who looked at whose personal documents. A PDF viewer fetches the file
  // several times (range requests, reloads), so one person opening one document counts once per few minutes.
  const opened = await AuditLogModel.exists({
    action: "kyb.document_opened",
    "actor.staff": req.staffId,
    "details.documentId": doc.id,
    createdAt: { $gt: new Date(Date.now() - DOCUMENT_OPEN_WINDOW_MS) },
  });
  if (!opened) {
    const person = doc.person ? business.people.id(doc.person)?.fullName : null;
    await audit(await staffActor(req), {
      action: "kyb.document_opened",
      business: business._id,
      target: { kind: "business", id: business._id },
      summary: `Opened ${DOCUMENT_TYPES[doc.type as DocumentType]}${person ? ` for ${person}` : ""}`,
      details: { documentId: doc.id, type: doc.type, ...(doc.person && { person: String(doc.person) }) },
    });
  }
  await streamDocument(res, business._id, req.params.documentId);
};

export const approveBusiness: RequestHandler<IdParams> = async (req, res) => {
  await assertNoConflictOfInterest(req.staffId!, await findBusiness(req.params.id));
  const business = await decideSubmittedBusiness(req.params.id, {
    status: "approved",
    reviewedAt: new Date(),
    reviewedBy: req.staffId,
    $unset: { reviewNote: 1 },
  });
  await audit(await staffActor(req), {
    action: "kyb.approved",
    business: business._id,
    target: { kind: "business", id: business._id },
    summary: "Verification approved",
  });
  await KybDocumentModel.updateMany({ business: business._id }, { status: "accepted", $unset: { rejectionReason: 1 } });
  await kybDecided(business, "approved");

  // Approval stands even if Liquifia is down; the failure is recorded on the business and an
  // admin can retry with POST /businesses/:id/provision-account.
  const account = await provisionBusinessAccount(business._id).catch((err) => {
    console.error(`Account provisioning failed for business ${business.id}:`, err);
    return undefined;
  });

  await emailOwner(business, (to) => sendBusinessApprovedEmail(to, business.name, account?.accountNumber));
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
  const submitted = await findSubmittedBusiness(req.params.id, req.staffId!);
  // Checked before deciding, so a wrong id leaves the review untouched.
  for (const { id } of body.documents) {
    if (!(await KybDocumentModel.exists({ _id: id, business: submitted._id }))) {
      throw new HttpError(400, `Document ${id} does not belong to this business`);
    }
  }

  const business = await decideSubmittedBusiness(submitted.id, {
    status: "changes_requested",
    reviewNote: body.note,
    reviewedAt: new Date(),
    reviewedBy: req.staffId,
  });
  await audit(await staffActor(req), {
    action: "kyb.changes_requested",
    business: business._id,
    target: { kind: "business", id: business._id },
    summary: "Asked for changes to the verification",
    details: { note: body.note, documents: body.documents },
  });
  for (const { id, reason } of body.documents) {
    await KybDocumentModel.updateOne({ _id: id, business: business._id }, { status: "rejected", rejectionReason: reason });
  }

  await kybDecided(business, "changes_requested", body.note);
  await emailOwner(business, (to) => sendBusinessChangesRequestedEmail(to, business.name, body.note));
  await sendBusinessOverview(res, business, { audience: "admin" });
};

export const rejectBusiness: RequestHandler<IdParams> = async (req, res) => {
  const body = z.object({ reason: z.string().trim().min(1) }).parse(req.body);
  await assertNoConflictOfInterest(req.staffId!, await findBusiness(req.params.id));
  const business = await decideSubmittedBusiness(req.params.id, {
    status: "rejected",
    reviewNote: body.reason,
    reviewedAt: new Date(),
    reviewedBy: req.staffId,
  });
  await audit(await staffActor(req), {
    action: "kyb.rejected",
    business: business._id,
    target: { kind: "business", id: business._id },
    summary: "Verification rejected",
    details: { reason: body.reason },
  });

  await kybDecided(business, "rejected", body.reason);
  await emailOwner(business, (to) => sendBusinessRejectedEmail(to, business.name, body.reason));
  await sendBusinessOverview(res, business, { audience: "admin" });
};

/** Pulls incoming transfers from Liquifia now (normally done every minute in the background). */
export const syncTransactions: RequestHandler = async (req, res) => {
  await audit(await staffActor(req), { action: "transactions.synced", summary: "Pulled incoming payments from the bank partner" });
  res.json(await syncInboundTransfers());
};
