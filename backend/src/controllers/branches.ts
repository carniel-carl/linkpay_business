import type { RequestHandler } from "express";
import { isValidObjectId, type Types } from "mongoose";
import { z } from "zod";
import { BranchModel, type BranchDocument } from "../models/Branch";
import { VirtualAccountModel } from "../models/VirtualAccount";
import { ensureHeadOffice, provisionBranchAccount } from "../services/accounts";
import { branchScope, canAccessBranch } from "../services/team";
import { HttpError } from "../utils/HttpError";

type BranchParams = { id: string };

const branchFields = z.object({
  name: z.string().trim().min(2).max(80),
  address: z
    .object({
      street: z.string().trim().min(1),
      city: z.string().trim().min(1),
      state: z.string().trim().min(1),
    })
    .partial(),
  manager: z
    .object({
      name: z.string().trim().min(2),
      email: z.email().trim().toLowerCase(),
      phone: z.string().trim().min(7).max(20),
    })
    .partial(),
});

/**
 * Branch as returned to clients, with its account details (no balance; use GET /api/accounts).
 * Owners only see the account setup status; admins also see the last provisioning error.
 */
export async function serializeBranches(branches: BranchDocument[], { audience = "owner" }: { audience?: "owner" | "admin" } = {}) {
  const accounts = await VirtualAccountModel.find({ branch: { $in: branches.map((b) => b._id) } });
  return branches.map((branch) => {
    const json = branch.toJSON() as Record<string, any>;
    json.liquifia =
      audience === "admin"
        ? { accountStatus: branch.liquifia?.accountStatus, customerId: branch.liquifia?.customerId, lastError: branch.liquifia?.lastError }
        : { accountStatus: branch.liquifia?.accountStatus ?? "not_started" };
    const account = accounts.find((a) => a.branch?.equals(branch._id));
    json.account = account
      ? { id: account.id, accountNumber: account.accountNumber, accountName: account.accountName, bankName: account.bankName, currency: account.currency }
      : null;
    return json;
  });
}

export async function findBranch(businessId: Types.ObjectId, id: string) {
  if (!isValidObjectId(id)) throw new HttpError(400, "Invalid id");
  const branch = await BranchModel.findOne({ _id: id, business: businessId });
  if (!branch) throw new HttpError(404, "Branch not found");
  return branch;
}

function rethrowDuplicateName(err: any): never {
  if (err?.code === 11000 && err.keyPattern?.name) {
    throw new HttpError(409, "You already have a branch with this name", "BRANCH_NAME_TAKEN");
  }
  throw err;
}

/** Head office first, then the other branches in the order they were added. Limited to the member's branches. */
export const listBranches: RequestHandler = async (req, res) => {
  const business = req.business!;
  await ensureHeadOffice(business);
  const scope = branchScope(req.membership!);
  const branches = await BranchModel.find({ business: business._id, ...(scope && { _id: { $in: scope } }) }).sort({
    isHeadOffice: -1,
    createdAt: 1,
  });
  res.json(await serializeBranches(branches));
};

export const getBranch: RequestHandler<BranchParams> = async (req, res) => {
  const branch = await findBranch(req.business!._id, req.params.id);
  // Out-of-scope branches look the same as missing ones.
  if (!canAccessBranch(req.membership!, branch._id)) throw new HttpError(404, "Branch not found");
  res.json((await serializeBranches([branch]))[0]);
};

/** Adds a branch and opens its own bank account straight away. */
export const createBranch: RequestHandler = async (req, res) => {
  const body = branchFields.partial().required({ name: true }).parse(req.body);
  const business = req.business!;
  await ensureHeadOffice(business);

  const branch = await BranchModel.create({ ...body, business: business._id }).catch(rethrowDuplicateName);

  // The branch stands even if Liquifia is down; the failure is recorded on the branch and an
  // admin can retry with POST /api/admin/businesses/:id/branches/:branchId/provision-account.
  await provisionBranchAccount(branch._id).catch((err) => {
    console.error(`Account provisioning failed for branch ${branch.id}:`, err);
  });

  const fresh = (await BranchModel.findById(branch._id))!;
  res.status(201).json((await serializeBranches([fresh]))[0]);
};

export const updateBranch: RequestHandler<BranchParams> = async (req, res) => {
  const body = branchFields.partial().parse(req.body);
  const branch = await findBranch(req.business!._id, req.params.id);

  const { address, manager, ...rest } = body;
  branch.set(rest);
  if (address) branch.set({ address: { ...branch.toObject().address, ...address } });
  if (manager) branch.set({ manager: { ...branch.toObject().manager, ...manager } });
  await branch.save().catch(rethrowDuplicateName);

  if (body.name && !branch.isHeadOffice) {
    await VirtualAccountModel.updateOne({ branch: branch._id }, { label: branch.name });
  }
  res.json((await serializeBranches([branch]))[0]);
};
