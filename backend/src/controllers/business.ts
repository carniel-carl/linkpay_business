import type { RequestHandler, Response } from "express";
import { isValidObjectId, type Types } from "mongoose";
import { z } from "zod";
import { BUSINESS_TYPES, DOCUMENT_TYPE_KEYS, ID_TYPES, PERSON_ROLES } from "../config/kyb";
import { BranchModel } from "../models/Branch";
import { BusinessModel, type BusinessDocument } from "../models/Business";
import { KybDocumentModel } from "../models/KybDocument";
import type { MembershipDocument } from "../models/Membership";
import { VirtualAccountModel } from "../models/VirtualAccount";
import { requestedBusinessId } from "../middleware/roles";
import { branchScope, describeMembership, ensureOwnerMembership, hasPermission, resolveBusinessContext } from "../services/team";
import { UserModel } from "../models/User";
import { detectFileType } from "../middleware/upload";
import { sendBusinessSubmittedEmail } from "../services/email";
import { buildChecklist } from "../services/kyb";
import { serializeBranches } from "./branches";
import { readFile, removeFile, saveFile } from "../services/storage";
import { encrypt } from "../utils/crypto";
import { HttpError } from "../utils/HttpError";

type PersonParams = { personId: string };
type DocParams = { documentId: string };

const EDITABLE_STATUSES = ["draft", "changes_requested"];

const businessFields = z.object({
  name: z.string().trim().min(2),
  type: z.enum(BUSINESS_TYPES),
  registrationNumber: z.string().trim().min(1),
  tin: z.string().trim().min(1),
  industry: z.string().trim().min(1),
  description: z.string().trim().max(1000),
  email: z.email().trim().toLowerCase(),
  phone: z.string().trim().min(7).max(20),
  website: z.url(),
  // Every address field is optional so the dashboard can save one field at a time.
  address: z
    .object({
      street: z.string().trim().min(1),
      city: z.string().trim().min(1),
      state: z.string().trim().min(1),
    })
    .partial(),
});

const personFields = z.object({
  fullName: z.string().trim().min(2),
  roles: z.array(z.enum(PERSON_ROLES)).min(1),
  email: z.email().trim().toLowerCase(),
  phone: z.string().trim().min(7).max(20),
  ownershipPercent: z.number().min(0).max(100),
  idType: z.enum(ID_TYPES),
  bvn: z.string().regex(/^\d{11}$/, "BVN must be 11 digits"),
});

async function findOwnBusiness(userId: string | undefined) {
  const business = await BusinessModel.findOne({ owner: userId });
  if (!business) throw new HttpError(404, "You haven't set up a business yet", "BUSINESS_REQUIRED");
  return business;
}

async function findEditableBusiness(userId: string | undefined) {
  const business = await findOwnBusiness(userId);
  if (!EDITABLE_STATUSES.includes(business.status)) {
    throw new HttpError(409, `Business can't be edited while ${business.status}`, "BUSINESS_LOCKED");
  }
  return business;
}

function applyPerson(person: { set: (k: string, v: unknown) => void }, data: Partial<z.infer<typeof personFields>>) {
  const { bvn, ...rest } = data;
  for (const [k, v] of Object.entries(rest)) person.set(k, v);
  if (bvn) {
    person.set("bvnEncrypted", encrypt(bvn));
    person.set("bvnLast4", bvn.slice(-4));
  }
}

/**
 * Shared response shape: business, its documents, accounts, branches, and what's still missing.
 * Owners only see the account setup status; platform admins also see provider ids and errors.
 * With a `membership` (team members), `membership` is included, branches and accounts are limited to
 * the member's branches, and roles below admin don't get verification documents or people's details.
 */
export async function sendBusinessOverview(
  res: Response,
  business: BusinessDocument,
  {
    status = 200,
    audience = "owner",
    membership,
  }: { status?: number; audience?: "owner" | "admin"; membership?: MembershipDocument } = {},
) {
  // Owner-only onboarding routes don't pass one; the caller is the owner.
  if (!membership && audience === "owner") membership = await ensureOwnerMembership(business);
  const scope = membership ? branchScope(membership) : null;
  const [documents, accounts, branches] = await Promise.all([
    KybDocumentModel.find({ business: business._id }).sort({ createdAt: 1 }),
    VirtualAccountModel.find({ business: business._id, ...(scope && { branch: { $in: scope } }) }),
    BranchModel.find({ business: business._id, ...(scope && { _id: { $in: scope } }) }).sort({ isHeadOffice: -1, createdAt: 1 }),
  ]);
  const json = business.toJSON() as Record<string, any>;
  if (audience === "owner") json.liquifia = { accountStatus: business.liquifia?.accountStatus ?? "not_started" };

  // For a branch-limited member the head office's status isn't theirs; use their first branch's.
  if (scope && audience === "owner") {
    json.liquifia = { accountStatus: branches[0]?.liquifia?.accountStatus ?? "not_started" };
  }

  const seesVerification = audience === "admin" || !membership || hasPermission(membership, "team.manage");
  if (!seesVerification) json.people = [];
  const checklist = buildChecklist(business, documents);

  res.status(status).json({
    business: json,
    documents: seesVerification ? documents : [],
    accounts,
    branches: await serializeBranches(branches, { audience }),
    checklist: seesVerification ? checklist : { complete: checklist.complete, items: [] },
    ...(audience === "owner" && membership && { membership: describeMembership(membership) }),
  });
}

export async function streamDocument(res: Response, businessId: Types.ObjectId, documentId: string) {
  if (!isValidObjectId(documentId)) throw new HttpError(400, "Invalid id");
  const doc = await KybDocumentModel.findOne({ _id: documentId, business: businessId });
  if (!doc) throw new HttpError(404, "Document not found");
  res
    .type(doc.mimeType)
    .setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(doc.originalName)}"`)
    .send(await readFile(doc.storageKey));
}

// ---- Business profile ----

export const createBusiness: RequestHandler = async (req, res) => {
  const body = businessFields.partial().required({ name: true, type: true }).parse(req.body);

  if (await BusinessModel.exists({ owner: req.userId })) {
    throw new HttpError(409, "You already have a business on this account", "BUSINESS_EXISTS");
  }
  const business = await BusinessModel.create({ ...body, owner: req.userId });
  await sendBusinessOverview(res, business, { status: 201 });
};

/** The business this request acts on (X-Business-Id header, or the user's default), for owners and team members. */
export const getMyBusiness: RequestHandler = async (req, res) => {
  const { business, membership } = await resolveBusinessContext(req.userId!, requestedBusinessId(req.headers["x-business-id"]));
  await sendBusinessOverview(res, business, { membership });
};

export const updateBusiness: RequestHandler = async (req, res) => {
  const body = businessFields.partial().parse(req.body);
  const business = await findEditableBusiness(req.userId);

  const { address, ...rest } = body;
  business.set(rest);
  if (address) business.set({ address: { ...business.toObject().address, ...address } });
  await business.save();
  await sendBusinessOverview(res, business);
};

// ---- Directors / owners / signatories ----

export const addPerson: RequestHandler = async (req, res) => {
  const body = personFields.partial().required({ fullName: true, roles: true }).parse(req.body);
  const business = await findEditableBusiness(req.userId);

  business.people.push({ fullName: body.fullName, roles: body.roles });
  applyPerson(business.people.at(-1)!, body);
  await business.save();
  await sendBusinessOverview(res, business, { status: 201 });
};

export const updatePerson: RequestHandler<PersonParams> = async (req, res) => {
  const body = personFields.partial().parse(req.body);
  const business = await findEditableBusiness(req.userId);

  const person = business.people.id(req.params.personId);
  if (!person) throw new HttpError(404, "Person not found");
  applyPerson(person, body);
  await business.save();
  await sendBusinessOverview(res, business);
};

export const removePerson: RequestHandler<PersonParams> = async (req, res) => {
  const business = await findEditableBusiness(req.userId);

  const person = business.people.id(req.params.personId);
  if (!person) throw new HttpError(404, "Person not found");
  person.deleteOne();
  await business.save();

  const docs = await KybDocumentModel.find({ business: business._id, person: req.params.personId });
  await Promise.all(docs.map((d) => removeFile(d.storageKey)));
  await KybDocumentModel.deleteMany({ _id: { $in: docs.map((d) => d._id) } });

  await sendBusinessOverview(res, business);
};

// ---- Documents ----

export const uploadDocument: RequestHandler = async (req, res) => {
  const body = z
    .object({ type: z.enum(DOCUMENT_TYPE_KEYS), personId: z.string().optional() })
    .parse(req.body);
  if (!req.file) throw new HttpError(400, "Attach the file in a 'file' form field", "FILE_REQUIRED");

  const business = await findEditableBusiness(req.userId);

  if (body.type === "government_id") {
    if (!body.personId || !business.people.id(body.personId)) {
      throw new HttpError(400, "government_id uploads need a valid personId");
    }
  } else if (body.personId) {
    throw new HttpError(400, "personId only applies to government_id uploads");
  }

  const { mime, ext } = detectFileType(req.file.buffer);
  const storageKey = `kyb/${business.id}/${crypto.randomUUID()}.${ext}`;
  await saveFile(storageKey, req.file.buffer);

  // Uploading again replaces the previous file of the same type (and person).
  const filter = { business: business._id, type: body.type, person: body.personId ?? null };
  const previous = await KybDocumentModel.findOne(filter);
  if (previous) {
    await removeFile(previous.storageKey);
    await previous.deleteOne();
  }

  await KybDocumentModel.create({
    ...filter,
    person: body.personId,
    storageKey,
    originalName: req.file.originalname,
    mimeType: mime,
    size: req.file.size,
    uploadedBy: req.userId,
  });
  await sendBusinessOverview(res, business, { status: 201 });
};

export const downloadDocument: RequestHandler<DocParams> = async (req, res) => {
  const business = await findOwnBusiness(req.userId);
  await streamDocument(res, business._id, req.params.documentId);
};

export const deleteDocument: RequestHandler<DocParams> = async (req, res) => {
  const business = await findEditableBusiness(req.userId);
  if (!isValidObjectId(req.params.documentId)) throw new HttpError(400, "Invalid id");

  const doc = await KybDocumentModel.findOne({ _id: req.params.documentId, business: business._id });
  if (!doc) throw new HttpError(404, "Document not found");
  await removeFile(doc.storageKey);
  await doc.deleteOne();
  await sendBusinessOverview(res, business);
};

// ---- Submission ----

export const submitForReview: RequestHandler = async (req, res) => {
  const business = await findEditableBusiness(req.userId);
  const documents = await KybDocumentModel.find({ business: business._id });

  const checklist = buildChecklist(business, documents);
  if (!checklist.complete) {
    return void res.status(400).json({
      error: "Complete all requirements before submitting",
      code: "KYB_INCOMPLETE",
      missing: checklist.items.filter((i) => !i.done),
    });
  }

  business.set({ status: "submitted", submittedAt: new Date(), reviewNote: undefined });
  await business.save();

  const owner = await UserModel.findById(req.userId);
  if (owner) await sendBusinessSubmittedEmail(owner.email, business.name);

  await sendBusinessOverview(res, business);
};
