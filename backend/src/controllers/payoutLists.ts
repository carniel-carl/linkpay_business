import type { Request, RequestHandler } from "express";
import { isValidObjectId, Types } from "mongoose";
import { z } from "zod";
import { BeneficiaryModel } from "../models/Beneficiary";
import { BranchModel } from "../models/Branch";
import { PayoutListModel, type PayoutListDocument } from "../models/PayoutList";
import { TransferBatchModel, TransferModel, type TransferDocument } from "../models/Transfer";
import { UserModel } from "../models/User";
import { keyedPayoutRows, resolvePayoutRows, saveBeneficiary } from "../services/beneficiaries";
import { todayInLagos } from "../services/pockets";
import { branchScope, canAccessBranch } from "../services/team";
import { createTransfers, keyedTransferRow, replayBeforeLookups } from "../services/transfers";
import { HttpError } from "../utils/HttpError";
import { assertSameRequest, isDuplicateClientKey, requestHash } from "../utils/idempotency";
import { describeBulkResult, MAX_BULK_ITEMS, requiredClientKey, reviewedName } from "./transfers";

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
// A run's rows may carry the account name the member reviewed, as bulk rows do: a saved name that has changed
// since is refused with ACCOUNT_NAME_CHANGED. It's a check only, so it isn't saved with `saveItems`.
const runItems = z.array(item.extend({ accountName: reviewedName })).min(1).max(MAX_BULK_ITEMS);

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

/** A filter for the lists a member can see, as visibleTo: those for their branches, and those with no branch. */
export function visibleListsFilter(req: Request) {
  const scope = branchScope(req.membership!);
  return scope ? { $or: [{ branch: { $exists: false } }, { branch: null }, { branch: { $in: scope } }] } : {};
}

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
      // The last run made a batch, or a single transfer when it paid one person: one of these is set.
      lastBatch: l.lastBatch ? String(l.lastBatch) : null,
      lastTransfer: l.lastTransfer ? String(l.lastTransfer) : null,
      createdBy: u ? { _id: u.id, name: u.name } : null,
      createdAt: l.get("createdAt"),
      updatedAt: l.get("updatedAt"),
      ...(withItems && {
        items: l.items.map((i) => {
          const ben = beneficiaries.find((x) => x._id.equals(i.beneficiary));
          return {
            // The account with its bank's uuid, as a run's request hash sees a row: the apps key a run by it.
            beneficiary: ben
              ? {
                  _id: ben.id,
                  accountName: ben.accountName,
                  nickname: ben.nickname ?? null,
                  accountNumber: ben.accountNumber,
                  bankName: ben.bankName ?? null,
                  bankUuid: ben.bankUuid,
                }
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
  const lists = await PayoutListModel.find({ business: req.business!._id, ...visibleListsFilter(req) }).sort({ updatedAt: -1 });
  res.json({ items: await serialize(lists) });
};

export const getPayoutList: RequestHandler<IdParams> = async (req, res) => {
  res.json((await serialize([await findList(req, req.params.id)], true))[0]);
};

/**
 * `{ title, branch?, items: [{ beneficiary, amountKobo, narration? }] }`, or `{ title, fromBatch }` to save a
 * past bulk transfer as a list (its recipients are added to the beneficiaries). Send an Idempotency-Key header
 * so a retry after a dropped response doesn't save the list twice.
 */
export const createPayoutList: RequestHandler = async (req, res) => {
  const body = z
    .union([
      z.object({ title, branch: objectId.optional(), items }),
      z.object({ title, branch: objectId.optional(), fromBatch: objectId }),
    ])
    .parse(req.body);
  const business = req.business!;
  const key = clientKey(req);
  // What this request asks for, so the same Idempotency-Key with different details is refused.
  const hash = key
    ? requestHash({
        title: body.title,
        branch: body.branch ?? null,
        fromBatch: "fromBatch" in body ? body.fromBatch : null,
        items: "items" in body ? body.items.map((i) => ({ beneficiary: i.beneficiary, amountKobo: i.amountKobo, narration: i.narration ?? null })) : null,
      })
    : undefined;

  /** The list first saved with this Idempotency-Key, if it was used before. */
  const replay = async () => {
    if (!key) return null;
    const first = await PayoutListModel.findOne({ business: business._id, createdBy: req.userId, clientKey: key });
    if (!first) return null;
    assertSameRequest(first.requestHash, hash);
    if (!visibleTo(req, first)) throw new HttpError(404, "Payout list not found", "PAYOUT_LIST_NOT_FOUND");
    return first;
  };
  const replied = async (list: PayoutListDocument) => void res.status(200).json((await serialize([list], true))[0]);

  // Before the limit and the checks: a retry gets the list it saved, even at 100 lists or with a beneficiary gone since.
  const earlier = await replay();
  if (earlier) return replied(earlier);

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

  let list;
  try {
    list = await PayoutListModel.create({
      business: business._id,
      title: body.title,
      branch,
      items: listItems,
      createdBy: req.userId,
      clientKey: key,
      requestHash: hash,
    });
  } catch (err) {
    // The same request sent twice at once, and the other one saved first: answer as its replay.
    const replayed = isDuplicateClientKey(err) ? await replay() : null;
    if (replayed) return replied(replayed);
    throw err;
  }
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
 * After a run has been sent: notes it on the list ("last paid" links to its batch, or to its one transfer when a
 * single row was paid), and with `saveItems` keeps the run's rows as the list's. Best effort: the money has
 * moved, so nothing here may turn the run into an error. If a beneficiary in the rows was deleted meanwhile,
 * the list keeps its rows; if the list itself was deleted, there's nothing to note.
 */
async function recordRun(
  req: Request,
  list: PayoutListDocument,
  run: { transfers: TransferDocument[]; batch: { _id: Types.ObjectId } | null; saveItems?: z.infer<typeof items> },
) {
  try {
    const lastBatch = run.batch?._id ?? run.transfers[0]?.batch ?? undefined;
    list.set({ lastRunAt: new Date(), lastBatch, lastTransfer: lastBatch ? undefined : run.transfers[0]?._id });
    if (run.saveItems) {
      const kept = await checkItems(req, run.saveItems).catch((err) => {
        console.error(`Payout list ${list.id}: the run was sent, but its rows weren't saved to the list:`, err);
        return null;
      });
      if (kept) list.set("items", kept);
    }
    await list.save();
  } catch (err) {
    console.error(`Payout list ${list.id}: the run was sent, but couldn't be noted on the list:`, err);
  }
}

/**
 * Pays the list as a bulk transfer, so the approval rules apply as usual. `branch` overrides the list's
 * account; `items` overrides the rows for this run (e.g. this month's amounts), and `saveItems: true` keeps
 * them on the list. Needs an Idempotency-Key header (the same one to retry), as POST /transfers/bulk does.
 */
export const runPayoutList: RequestHandler<IdParams> = async (req, res) => {
  const body = z
    .object({ branch: objectId.optional(), title: z.string().trim().max(80).optional(), items: runItems.optional(), saveItems: z.boolean().optional() })
    .parse(req.body ?? {});
  if (!isValidObjectId(req.params.id)) throw new HttpError(400, "Invalid id");
  const business = req.business!;
  const key = requiredClientKey(req);
  // A retry is answered before the list is looked up, so it gets the first run's result even if the list, or a
  // beneficiary in it, was deleted or changed since. The rows (the body's, matched with what the run sent, or
  // the run's own when the body left them to the list) and the account are read from what that run created;
  // the list's id is part of the request, so a key used for another list is still refused.
  const early = await replayBeforeLookups({
    business,
    membership: req.membership!,
    userId: req.userId!,
    branchId: body.branch,
    payoutList: new Types.ObjectId(req.params.id),
    clientKey: key,
    rows: (sent) => (body.items ? keyedPayoutRows(business, body.items, sent) : sent.map(keyedTransferRow)),
  });
  if (early) return void res.status(200).json(await describeBulkResult(req, early.transfers, early.batch));

  const list = await findList(req, req.params.id);
  const branch = body.branch ?? (list.branch ? String(list.branch) : undefined);
  if (!branch) throw new HttpError(400, "Choose the account to pay from", "BRANCH_REQUIRED");

  const rows = body.items ?? list.items.map((i) => ({ beneficiary: String(i.beneficiary), amountKobo: i.amountKobo, narration: i.narration ?? undefined }));
  const requests = await resolvePayoutRows(business, rows, { userId: req.userId! });
  const { transfers, batch, replayed } = await createTransfers({
    business,
    membership: req.membership!,
    userId: req.userId!,
    branchId: branch,
    requests,
    batchTitle: body.title ?? `${list.title} (${todayInLagos()})`,
    payoutList: list._id,
    clientKey: key,
  });

  if (!replayed) await recordRun(req, list, { transfers, batch, saveItems: body.saveItems ? body.items : undefined });
  res.status(replayed ? 200 : 201).json(await describeBulkResult(req, transfers, batch));
};
