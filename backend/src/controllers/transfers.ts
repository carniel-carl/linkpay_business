import type { Request, RequestHandler } from "express";
import { isValidObjectId, Types } from "mongoose";
import { z } from "zod";
import { BranchModel } from "../models/Branch";
import { TRANSFER_KINDS, TRANSFER_STATUSES, TransferBatchModel, TransferModel, type TransferDocument } from "../models/Transfer";
import { UserModel } from "../models/User";
import { branchScope, canAccessBranch, hasPermission } from "../services/team";
import {
  cancelTransfers,
  createTransfers,
  decideTransfers,
  listBanks,
  needsApproval,
  quoteFee,
  refreshTransfer,
  resolveBankRecipient,
  resolveBranchRecipient,
  type TransferRequest,
} from "../services/transfers";
import { HttpError } from "../utils/HttpError";

type IdParams = { id: string };

const objectId = z.string().refine(isValidObjectId, "Invalid id");
const accountNumber = z.string().trim().regex(/^\d{10}$/, "Account numbers are 10 digits");
// ₦1 to ₦100m per transfer; the available balance is the real limit.
const amountKobo = z.number().int().min(100, "The smallest transfer is ₦1").max(100_000_000_00);
const narration = z.string().trim().max(100).optional();
const note = z.object({ note: z.string().trim().max(300).optional() });

function clientKey(req: Request) {
  const key = req.header("idempotency-key")?.trim();
  if (key && !/^[A-Za-z0-9_-]{8,100}$/.test(key)) throw new HttpError(400, "Invalid Idempotency-Key header");
  return key || undefined;
}

// ---------------------------------------------------------------------------------------------------------

async function serialize(req: Request, transfers: TransferDocument[]) {
  const userIds = transfers.flatMap((t) => [t.createdBy, t.decision?.by].filter(Boolean));
  const branchIds = transfers.flatMap((t) => [t.branch, t.recipient?.branch].filter(Boolean));
  const [users, branches] = await Promise.all([
    UserModel.find({ _id: { $in: userIds } }).select("name"),
    BranchModel.find({ _id: { $in: branchIds } }).select("name isHeadOffice"),
  ]);
  const user = (id?: Types.ObjectId | null) => {
    const u = id && users.find((x) => x._id.equals(id));
    return u ? { _id: u.id, name: u.name } : null;
  };
  const branch = (id?: Types.ObjectId | null) => {
    const b = id && branches.find((x) => x._id.equals(id));
    return b ? { _id: b.id, name: b.name, isHeadOffice: b.isHeadOffice } : null;
  };
  const me = req.userId!;
  const mayApprove = hasPermission(req.membership!, "transfers.approve");

  return transfers.map((t) => ({
    _id: t.id,
    kind: t.kind,
    status: t.status,
    amountKobo: t.amountKobo,
    feeKobo: t.feeKobo,
    stampDutyKobo: t.stampDutyKobo,
    totalKobo: t.totalKobo,
    currency: t.currency,
    branch: branch(t.branch),
    batch: t.batch ? String(t.batch) : null,
    recipient: {
      accountNumber: t.recipient!.accountNumber,
      accountName: t.recipient!.accountName,
      bankName: t.recipient!.bankName ?? null,
      // Internal transfers: the receiving branch.
      branch: t.kind === "internal" ? branch(t.recipient!.branch) : null,
    },
    narration: t.narration ?? null,
    reference: t.reference,
    failureReason: t.failureReason ?? null,
    createdBy: user(t.createdBy),
    decision: t.decision?.by ? { by: user(t.decision.by), at: t.decision.at, note: t.decision.note ?? null } : null,
    createdAt: t.get("createdAt"),
    submittedAt: t.submittedAt ?? null,
    completedAt: t.completedAt ?? null,
    canApprove: t.status === "pending_approval" && mayApprove && !t.createdBy.equals(me),
    canCancel: t.status === "pending_approval" && t.createdBy.equals(me),
  }));
}

/** Loads a transfer of this business that the member may see. */
async function findTransfer(req: Request, id: string) {
  if (!isValidObjectId(id)) throw new HttpError(400, "Invalid id");
  const transfer = await TransferModel.findOne({ _id: id, business: req.business!._id });
  if (!transfer || !canAccessBranch(req.membership!, transfer.branch)) throw new HttpError(404, "Transfer not found");
  return transfer;
}

async function findBatch(req: Request, id: string) {
  if (!isValidObjectId(id)) throw new HttpError(400, "Invalid id");
  const batch = await TransferBatchModel.findOne({ _id: id, business: req.business!._id });
  if (!batch || !canAccessBranch(req.membership!, batch.branch)) throw new HttpError(404, "Transfer batch not found");
  const transfers = await TransferModel.find({ batch: batch._id }).sort({ _id: 1 });
  return { batch, transfers };
}

async function serializeBatch(req: Request, batch: InstanceType<typeof TransferBatchModel>, transfers: TransferDocument[]) {
  const items = await serialize(req, transfers);
  const counts = Object.fromEntries(TRANSFER_STATUSES.map((s) => [s, items.filter((i) => i.status === s).length]));
  return {
    _id: batch.id,
    title: batch.title ?? null,
    count: batch.count,
    amountKobo: batch.amountKobo,
    feeKobo: batch.feeKobo,
    totalKobo: batch.totalKobo,
    createdAt: batch.get("createdAt"),
    statusCounts: counts,
    items,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------------------------------------

export const getBanks: RequestHandler = async (_req, res) => {
  const banks = await listBanks();
  res.json(banks.map((b) => ({ uuid: b.uuid, name: b.name, code: b.code ?? null })));
};

/** Name enquiry before sending: who owns this account, and is it on LinkPay? */
export const resolveAccount: RequestHandler = async (req, res) => {
  const body = z.object({ accountNumber, bankUuid: z.string().trim().min(1) }).parse(req.body);
  const recipient = await resolveBankRecipient(req.business!, body.accountNumber, body.bankUuid);
  res.json({
    accountNumber: recipient.accountNumber,
    accountName: recipient.accountName,
    bankName: recipient.bankName ?? null,
    kind: recipient.kind,
    // The receiving business (LinkPay) or branch (internal), when it's one of ours.
    label: recipient.label ?? null,
  });
};

/** Fee for one transfer of `amountKobo`, plus whether the signed-in member's transfer would need approval. */
export const getFee: RequestHandler = async (req, res) => {
  const query = z.object({ amountKobo: z.coerce.number().pipe(amountKobo) }).parse(req.query);
  const fee = await quoteFee(query.amountKobo);
  res.json({
    amountKobo: query.amountKobo,
    ...fee,
    totalKobo: query.amountKobo + fee.feeKobo,
    needsApproval: needsApproval(req.business!, req.membership!, query.amountKobo),
  });
};

// ---------------------------------------------------------------------------------------------------------
// Approval rule
// ---------------------------------------------------------------------------------------------------------

function describeApprovalRule(req: Request) {
  const rule = req.business!.transferApproval;
  return { mode: rule?.mode ?? "never", thresholdKobo: rule?.thresholdKobo ?? null };
}

export const getTransferSettings: RequestHandler = async (req, res) => {
  res.json({ approval: describeApprovalRule(req) });
};

export const updateTransferSettings: RequestHandler = async (req, res) => {
  const body = z
    .object({
      approval: z.discriminatedUnion("mode", [
        z.object({ mode: z.literal("never") }),
        z.object({ mode: z.literal("always") }),
        z.object({ mode: z.literal("above_threshold"), thresholdKobo: z.number().int().min(100) }),
      ]),
    })
    .parse(req.body);
  const business = req.business!;
  business.set("transferApproval", {
    mode: body.approval.mode,
    thresholdKobo: body.approval.mode === "above_threshold" ? body.approval.thresholdKobo : undefined,
  });
  await business.save();
  res.json({ approval: describeApprovalRule(req) });
};

// ---------------------------------------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------------------------------------

const listFilters = z.object({
  status: z.enum(TRANSFER_STATUSES).optional(),
  kind: z.enum(TRANSFER_KINDS).optional(),
  branch: objectId.optional(),
  batch: objectId.optional(),
  // "me": waiting for the signed-in member's approval.
  awaiting: z.literal("me").optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  q: z.string().trim().max(100).optional(),
  skip: z.coerce.number().int().min(0).default(0),
  take: z.coerce.number().int().min(1).max(100).default(20),
});

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Newest first. `?status=&kind=&branch=&batch=&awaiting=me&from=&to=&q=&skip=&take=` */
export const listTransfers: RequestHandler = async (req, res) => {
  const f = listFilters.parse(req.query);
  if (f.branch && !canAccessBranch(req.membership!, f.branch)) throw new HttpError(404, "Branch not found");
  const scope = branchScope(req.membership!);
  const filter: Record<string, unknown> = { business: req.business!._id };
  if (f.branch) filter.branch = new Types.ObjectId(f.branch);
  else if (scope) filter.branch = { $in: scope };
  if (f.status) filter.status = f.status;
  if (f.kind) filter.kind = f.kind;
  if (f.batch) filter.batch = new Types.ObjectId(f.batch);
  if (f.awaiting) {
    if (!hasPermission(req.membership!, "transfers.approve")) {
      return void res.json({ items: [], total: 0, skip: f.skip, take: f.take });
    }
    filter.status = "pending_approval";
    filter.createdBy = { $ne: new Types.ObjectId(req.userId) };
  }
  if (f.from || f.to) filter.createdAt = { ...(f.from && { $gte: f.from }), ...(f.to && { $lte: f.to }) };
  if (f.q) {
    const re = new RegExp(escapeRegex(f.q), "i");
    filter.$or = [{ "recipient.accountName": re }, { "recipient.accountNumber": re }, { narration: re }, { reference: re }];
  }

  const [items, total] = await Promise.all([
    TransferModel.find(filter).sort({ createdAt: -1, _id: -1 }).skip(f.skip).limit(f.take),
    TransferModel.countDocuments(filter),
  ]);
  res.json({ items: await serialize(req, items), total, skip: f.skip, take: f.take });
};

export const getTransfer: RequestHandler<IdParams> = async (req, res) => {
  const transfer = await findTransfer(req, req.params.id);
  res.json((await serialize(req, [transfer]))[0]);
};

const recipientInput = z.discriminatedUnion("type", [
  z.object({ type: z.literal("bank"), accountNumber, bankUuid: z.string().trim().min(1) }),
  z.object({ type: z.literal("branch"), branch: objectId }),
]);

/** Sends money from one of the business's branch accounts. Send an Idempotency-Key header to retry safely. */
export const createTransfer: RequestHandler = async (req, res) => {
  const body = z.object({ branch: objectId, amountKobo, narration, recipient: recipientInput }).parse(req.body);
  const business = req.business!;
  const recipient =
    body.recipient.type === "branch"
      ? await resolveBranchRecipient(business, body.recipient.branch)
      : await resolveBankRecipient(business, body.recipient.accountNumber, body.recipient.bankUuid);

  const { transfers, replayed } = await createTransfers({
    business,
    membership: req.membership!,
    userId: req.userId!,
    branchId: body.branch,
    requests: [{ recipient, amountKobo: body.amountKobo, narration: body.narration }],
    clientKey: clientKey(req),
  });
  res.status(replayed ? 200 : 201).json((await serialize(req, transfers.slice(0, 1)))[0]);
};

const MAX_BULK_ITEMS = 200;

/**
 * Several transfers from one account at once. Every row is checked with the bank first; if any row fails,
 * nothing is created and the errors come back per row (`details.rows`).
 */
export const createBulkTransfer: RequestHandler = async (req, res) => {
  const body = z
    .object({
      branch: objectId,
      title: z.string().trim().max(80).optional(),
      items: z
        .array(z.object({ accountNumber, bankUuid: z.string().trim().min(1), amountKobo, narration }))
        .min(1)
        .max(MAX_BULK_ITEMS),
    })
    .parse(req.body);
  const business = req.business!;

  const requests: TransferRequest[] = new Array(body.items.length);
  const rows: { row: number; error: string; code?: string }[] = [];
  // A few lookups at a time: each is a name enquiry with the recipient's bank.
  let next = 0;
  await Promise.all(
    Array.from({ length: 5 }, async () => {
      while (next < body.items.length) {
        const i = next++;
        const item = body.items[i]!;
        try {
          const recipient = await resolveBankRecipient(business, item.accountNumber, item.bankUuid);
          requests[i] = { recipient, amountKobo: item.amountKobo, narration: item.narration };
        } catch (err) {
          if (!(err instanceof HttpError)) throw err;
          rows.push({ row: i, error: err.message, code: err.code });
        }
      }
    }),
  );
  if (rows.length) {
    throw new HttpError(422, `${rows.length} of ${body.items.length} rows need fixing`, "INVALID_ROWS", {
      rows: rows.sort((a, b) => a.row - b.row),
    });
  }

  const { transfers, batch, replayed } = await createTransfers({
    business,
    membership: req.membership!,
    userId: req.userId!,
    branchId: body.branch,
    requests,
    batchTitle: body.title,
    clientKey: clientKey(req),
  });
  const savedBatch = batch ?? (transfers[0]?.batch ? await TransferBatchModel.findById(transfers[0].batch) : null);
  if (!savedBatch) {
    // A single row is just a transfer.
    return void res.status(replayed ? 200 : 201).json({ batch: null, items: await serialize(req, transfers) });
  }
  res.status(replayed ? 200 : 201).json({ batch: await serializeBatch(req, savedBatch, transfers) });
};

export const approveTransfer: RequestHandler<IdParams> = async (req, res) => {
  const { note: text } = note.parse(req.body ?? {});
  const transfer = await findTransfer(req, req.params.id);
  const [decided] = await decideTransfers({ transfers: [transfer], membership: req.membership!, userId: req.userId!, decision: "approve", note: text });
  res.json((await serialize(req, [decided ?? (await findTransfer(req, req.params.id))]))[0]);
};

export const rejectTransfer: RequestHandler<IdParams> = async (req, res) => {
  const { note: text } = note.parse(req.body ?? {});
  const transfer = await findTransfer(req, req.params.id);
  await decideTransfers({ transfers: [transfer], membership: req.membership!, userId: req.userId!, decision: "reject", note: text });
  res.json((await serialize(req, [await findTransfer(req, req.params.id)]))[0]);
};

export const cancelTransfer: RequestHandler<IdParams> = async (req, res) => {
  const transfer = await findTransfer(req, req.params.id);
  await cancelTransfers([transfer], req.userId!);
  res.json((await serialize(req, [await findTransfer(req, req.params.id)]))[0]);
};

/** Asks Liquifia for the latest status now instead of waiting for the background check. */
export const refreshTransferStatus: RequestHandler<IdParams> = async (req, res) => {
  const transfer = await findTransfer(req, req.params.id);
  await refreshTransfer(transfer);
  res.json((await serialize(req, [await findTransfer(req, req.params.id)]))[0]);
};

// ---------------------------------------------------------------------------------------------------------
// Batches
// ---------------------------------------------------------------------------------------------------------

export const getBatch: RequestHandler<IdParams> = async (req, res) => {
  const { batch, transfers } = await findBatch(req, req.params.id);
  res.json(await serializeBatch(req, batch, transfers));
};

const decideBatch =
  (decision: "approve" | "reject"): RequestHandler<IdParams> =>
  async (req, res) => {
    const { note: text } = note.parse(req.body ?? {});
    const { batch, transfers } = await findBatch(req, req.params.id);
    const pending = transfers.filter((t) => t.status === "pending_approval");
    if (!pending.length) throw new HttpError(409, "Nothing in this batch is waiting for approval", "TRANSFER_NOT_PENDING");
    await decideTransfers({ transfers: pending, membership: req.membership!, userId: req.userId!, decision, note: text });
    res.json(await serializeBatch(req, batch, await TransferModel.find({ batch: batch._id }).sort({ _id: 1 })));
  };

export const approveBatch = decideBatch("approve");
export const rejectBatch = decideBatch("reject");

export const cancelBatch: RequestHandler<IdParams> = async (req, res) => {
  const { batch, transfers } = await findBatch(req, req.params.id);
  const pending = transfers.filter((t) => t.status === "pending_approval");
  if (!pending.length) throw new HttpError(409, "Nothing in this batch is waiting for approval", "TRANSFER_NOT_PENDING");
  await cancelTransfers(pending, req.userId!);
  res.json(await serializeBatch(req, batch, await TransferModel.find({ batch: batch._id }).sort({ _id: 1 })));
};
