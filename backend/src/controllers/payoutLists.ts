import type { Request, RequestHandler } from "express";
import { isValidObjectId, Types } from "mongoose";
import { z } from "zod";
import { BeneficiaryModel } from "../models/Beneficiary";
import { BranchModel } from "../models/Branch";
import { PayoutListModel, type PayoutListDocument } from "../models/PayoutList";
import { TransferBatchModel, TransferModel } from "../models/Transfer";
import { UserModel } from "../models/User";
import { resolvePayoutRows, saveBeneficiary } from "../services/beneficiaries";
import { todayInLagos } from "../services/pockets";
import { branchScope, canAccessBranch } from "../services/team";
import { createTransfers } from "../services/transfers";
import { HttpError } from "../utils/HttpError";
import { describeBulkResult, MAX_BULK_ITEMS } from "./transfers";

type IdParams = { id: string };

/** Saved payout lists per business. */
const MAX_LISTS = 100;

const objectId = z.string().refine(isValidObjectId, "Invalid id");
const title = z.string().trim().min(1, "Give the list a name").max(80);
const item = z.object({
  beneficiary: objectId,
  amountKobo: z.number().int().min(100, "The smallest transfer is ₦1").max(100_000_000_00),
  narration: z.string().trim().max(100).optional(),
});
const items = z.array(item).min(1).max(MAX_BULK_ITEMS);

function clientKey(req: Request) {
  const key = req.header("idempotency-key")?.trim();
  if (key && !/^[A-Za-z0-9_-]{8,100}$/.test(key)) throw new HttpError(400, "Invalid Idempotency-Key header");
  return key || undefined;
}

/** Every item must be one of this business's beneficiaries. */
async function checkItems(req: Request, list: z.infer<typeof items>) {
  const ids = [...new Set(list.map((i) => i.beneficiary))];
  const found = await BeneficiaryModel.countDocuments({ _id: { $in: ids }, business: req.business!._id });
  if (found !== ids.length) throw new HttpError(400, "Some of these beneficiaries aren't saved on this business", "BENEFICIARY_NOT_FOUND");
  return list.map((i) => ({ beneficiary: new Types.ObjectId(i.beneficiary), amountKobo: i.amountKobo, narration: i.narration }));
}

async function checkBranch(req: Request, branchId: string) {
  const branch = await BranchModel.findOne({ _id: branchId, business: req.business!._id });
  if (!branch || !canAccessBranch(req.membership!, branch._id)) throw new HttpError(404, "Branch not found");
  return branch._id;
}

const visibleTo = (req: Request, list: PayoutListDocument) => !list.branch || canAccessBranch(req.membership!, list.branch);

async function findList(req: Request, id: string) {
  if (!isValidObjectId(id)) throw new HttpError(400, "Invalid id");
  const list = await PayoutListModel.findOne({ _id: id, business: req.business!._id });
  if (!list || !visibleTo(req, list)) throw new HttpError(404, "Payout list not found", "PAYOUT_LIST_NOT_FOUND");
  return list;
}

async function serialize(lists: PayoutListDocument[], withItems = false) {
  const [users, branches, beneficiaries] = await Promise.all([
    UserModel.find({ _id: { $in: lists.map((l) => l.createdBy) } }).select("name"),
    BranchModel.find({ _id: { $in: lists.map((l) => l.branch).filter(Boolean) } }).select("name isHeadOffice"),
    withItems ? BeneficiaryModel.find({ _id: { $in: lists.flatMap((l) => l.items.map((i) => i.beneficiary)) } }) : [],
  ]);
  return lists.map((l) => {
    const u = users.find((x) => x._id.equals(l.createdBy));
    const b = l.branch && branches.find((x) => x._id.equals(l.branch!));
    return {
      _id: l.id as string,
      title: l.title,
      branch: b ? { _id: b.id, name: b.name, isHeadOffice: b.isHeadOffice } : null,
      count: l.items.length,
      // Before fees; the fee per transfer is quoted when it's run.
      amountKobo: l.items.reduce((s, i) => s + i.amountKobo, 0),
      lastRunAt: l.lastRunAt ?? null,
      lastBatch: l.lastBatch ? String(l.lastBatch) : null,
      createdBy: u ? { _id: u.id, name: u.name } : null,
      createdAt: l.get("createdAt"),
      updatedAt: l.get("updatedAt"),
      ...(withItems && {
        items: l.items.map((i) => {
          const ben = beneficiaries.find((x) => x._id.equals(i.beneficiary));
          return {
            beneficiary: ben
              ? { _id: ben.id, accountName: ben.accountName, nickname: ben.nickname ?? null, accountNumber: ben.accountNumber, bankName: ben.bankName ?? null }
              : null,
            amountKobo: i.amountKobo,
            narration: i.narration ?? null,
          };
        }),
      }),
    };
  });
}

// ---------------------------------------------------------------------------------------------------------

/** Lists the member can use (those for their branches, or with no branch), most recently changed first. */
export const listPayoutLists: RequestHandler = async (req, res) => {
  const scope = branchScope(req.membership!);
  const lists = await PayoutListModel.find({
    business: req.business!._id,
    ...(scope && { $or: [{ branch: { $exists: false } }, { branch: null }, { branch: { $in: scope } }] }),
  }).sort({ updatedAt: -1 });
  res.json({ items: await serialize(lists) });
};

export const getPayoutList: RequestHandler<IdParams> = async (req, res) => {
  res.json((await serialize([await findList(req, req.params.id)], true))[0]);
};

/**
 * `{ title, branch?, items: [{ beneficiary, amountKobo, narration? }] }`, or `{ title, fromBatch }` to save a
 * past bulk transfer as a list (its recipients are added to the beneficiaries).
 */
export const createPayoutList: RequestHandler = async (req, res) => {
  const body = z
    .union([
      z.object({ title, branch: objectId.optional(), items }),
      z.object({ title, branch: objectId.optional(), fromBatch: objectId }),
    ])
    .parse(req.body);
  const business = req.business!;
  if ((await PayoutListModel.countDocuments({ business: business._id })) >= MAX_LISTS) {
    throw new HttpError(409, `You can save up to ${MAX_LISTS} payout lists. Delete one to add another.`, "PAYOUT_LIST_LIMIT");
  }

  let listItems;
  let branch = body.branch ? await checkBranch(req, body.branch) : undefined;
  if ("fromBatch" in body) {
    const batch = await TransferBatchModel.findOne({ _id: body.fromBatch, business: business._id });
    if (!batch || !canAccessBranch(req.membership!, batch.branch)) throw new HttpError(404, "Transfer batch not found");
    const transfers = await TransferModel.find({ batch: batch._id }).sort({ _id: 1 });
    listItems = [];
    for (const t of transfers) {
      if (t.kind === "internal") continue;
      const beneficiary =
        t.recipient!.beneficiary ??
        (
          await saveBeneficiary(business, req.userId!, {
            kind: t.kind,
            accountNumber: t.recipient!.accountNumber,
            accountName: t.recipient!.accountName,
            bankName: t.recipient!.bankName ?? undefined,
            bankUuid: t.recipient!.bankUuid,
            business: t.recipient!.business ?? undefined,
          })
        ).beneficiary._id;
      listItems.push({ beneficiary, amountKobo: t.amountKobo, narration: t.narration ?? undefined });
    }
    if (!listItems.length) throw new HttpError(400, "This batch has no bank recipients to save", "PAYOUT_LIST_EMPTY");
    branch ??= batch.branch;
  } else {
    listItems = await checkItems(req, body.items);
  }

  const list = await PayoutListModel.create({ business: business._id, title: body.title, branch, items: listItems, createdBy: req.userId });
  res.status(201).json((await serialize([list], true))[0]);
};

/** Changes the title, default branch (`null` clears it) or the items (replaced as a whole). */
export const updatePayoutList: RequestHandler<IdParams> = async (req, res) => {
  const body = z.object({ title: title.optional(), branch: objectId.nullable().optional(), items: items.optional() }).strict().parse(req.body);
  const list = await findList(req, req.params.id);
  if (body.title) list.title = body.title;
  if (body.branch !== undefined) list.set("branch", body.branch ? await checkBranch(req, body.branch) : undefined);
  if (body.items) list.set("items", await checkItems(req, body.items));
  await list.save();
  res.json((await serialize([list], true))[0]);
};

export const deletePayoutList: RequestHandler<IdParams> = async (req, res) => {
  const list = await findList(req, req.params.id);
  await list.deleteOne();
  res.status(204).end();
};

/**
 * Pays the list as a bulk transfer, so the approval rules apply as usual. `branch` overrides the list's
 * account; `items` overrides the rows for this run (e.g. this month's amounts), and `saveItems: true` keeps
 * them on the list. Send an Idempotency-Key header to retry safely.
 */
export const runPayoutList: RequestHandler<IdParams> = async (req, res) => {
  const body = z
    .object({ branch: objectId.optional(), title: z.string().trim().max(80).optional(), items: items.optional(), saveItems: z.boolean().optional() })
    .parse(req.body ?? {});
  const list = await findList(req, req.params.id);
  const branch = body.branch ?? (list.branch ? String(list.branch) : undefined);
  if (!branch) throw new HttpError(400, "Choose the account to pay from", "BRANCH_REQUIRED");

  const rows = body.items ?? list.items.map((i) => ({ beneficiary: String(i.beneficiary), amountKobo: i.amountKobo, narration: i.narration ?? undefined }));
  const requests = await resolvePayoutRows(req.business!, rows, { userId: req.userId! });
  const { transfers, batch, replayed } = await createTransfers({
    business: req.business!,
    membership: req.membership!,
    userId: req.userId!,
    branchId: branch,
    requests,
    batchTitle: body.title ?? `${list.title} (${todayInLagos()})`,
    payoutList: list._id,
    clientKey: clientKey(req),
  });

  if (!replayed) {
    list.set({ lastRunAt: new Date(), lastBatch: batch?._id ?? transfers[0]?.batch ?? undefined });
    if (body.items && body.saveItems) list.set("items", await checkItems(req, body.items));
    await list.save();
  }
  res.status(replayed ? 200 : 201).json(await describeBulkResult(req, transfers, batch));
};
