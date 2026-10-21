import type { RequestHandler } from "express";
import { isValidObjectId, Types } from "mongoose";
import { z } from "zod";
import { TRANSACTION_STATUSES, TransactionModel, type TransactionDocument } from "../models/Transaction";
import { BranchModel } from "../models/Branch";
import { VirtualAccountModel } from "../models/VirtualAccount";
import { branchScope, canAccessBranch } from "../services/team";
import { syncIfStale } from "../services/transactions";
import { HttpError } from "../utils/HttpError";

type IdParams = { id: string };

// Lists refresh from Liquifia at most this often, and never wait longer than the timeout for it.
const SYNC_MAX_AGE_MS = 30_000;
const SYNC_WAIT_MS = 3_000;

async function freshen() {
  await Promise.race([syncIfStale(SYNC_MAX_AGE_MS).catch(() => {}), new Promise((r) => setTimeout(r, SYNC_WAIT_MS))]);
}

const objectId = z.string().refine(isValidObjectId, "Invalid id");
const filters = z.object({
  branch: objectId.optional(),
  direction: z.enum(["credit", "debit"]).optional(),
  status: z.enum(TRANSACTION_STATUSES).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  q: z.string().trim().max(100).optional(),
});

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Mongo filter for the business, the member's branch scope and the query filters. */
function buildFilter(req: Parameters<RequestHandler>[0], f: z.infer<typeof filters>) {
  if (f.branch && !canAccessBranch(req.membership!, f.branch)) throw new HttpError(404, "Branch not found");
  const scope = branchScope(req.membership!);
  const filter: Record<string, unknown> = { business: req.business!._id };
  if (f.branch) filter.branch = new Types.ObjectId(f.branch);
  else if (scope) filter.branch = { $in: scope };
  if (f.direction) filter.direction = f.direction;
  if (f.status) filter.status = f.status;
  if (f.from || f.to) filter.occurredAt = { ...(f.from && { $gte: f.from }), ...(f.to && { $lte: f.to }) };
  if (f.q) {
    const re = new RegExp(escapeRegex(f.q), "i");
    filter.$or = [{ "counterparty.name": re }, { narration: re }, { reference: re }, { "counterparty.accountNumber": re }];
  }
  return filter;
}

export async function serializeTransactions(transactions: TransactionDocument[]) {
  const [branches, accounts] = await Promise.all([
    BranchModel.find({ _id: { $in: transactions.map((t) => t.branch).filter(Boolean) } }).select("name isHeadOffice"),
    VirtualAccountModel.find({ _id: { $in: transactions.map((t) => t.virtualAccount) } }).select("label accountNumber bankName"),
  ]);
  return transactions.map((t) => {
    const branch = branches.find((b) => t.branch && b._id.equals(t.branch));
    const account = accounts.find((a) => a._id.equals(t.virtualAccount));
    return {
      _id: t.id,
      type: t.type,
      direction: t.direction,
      amountKobo: t.amountKobo,
      feeKobo: t.feeKobo,
      netKobo: t.netKobo,
      currency: t.currency,
      status: t.status,
      counterparty: t.counterparty ?? {},
      narration: t.narration ?? null,
      reference: t.reference ?? null,
      occurredAt: t.occurredAt,
      branch: branch ? { _id: branch.id, name: branch.name, isHeadOffice: branch.isHeadOffice } : null,
      account: account ? { _id: account.id, label: account.label, accountNumber: account.accountNumber, bankName: account.bankName } : null,
      // Payouts: the transfer they belong to.
      transfer: t.transfer ? String(t.transfer) : null,
    };
  });
}

/** Newest first. `?branch=&direction=&status=&from=&to=&q=&skip=&take=` */
export const listTransactions: RequestHandler = async (req, res) => {
  const query = filters
    .extend({
      skip: z.coerce.number().int().min(0).default(0),
      take: z.coerce.number().int().min(1).max(100).default(20),
    })
    .parse(req.query);
  await freshen();

  const filter = buildFilter(req, query);
  const [items, total] = await Promise.all([
    TransactionModel.find(filter).sort({ occurredAt: -1, _id: -1 }).skip(query.skip).limit(query.take),
    TransactionModel.countDocuments(filter),
  ]);
  res.json({ items: await serializeTransactions(items), total, skip: query.skip, take: query.take });
};

/** Money in and out (successful only) for the same filters, e.g. "this month" on the dashboard. */
export const transactionSummary: RequestHandler = async (req, res) => {
  const query = filters.omit({ status: true, direction: true }).parse(req.query);
  await freshen();

  const [totals] = await TransactionModel.aggregate([
    { $match: { ...buildFilter(req, query), status: "success" } },
    {
      $group: {
        _id: null,
        inflowKobo: { $sum: { $cond: [{ $eq: ["$direction", "credit"] }, "$amountKobo", 0] } },
        outflowKobo: { $sum: { $cond: [{ $eq: ["$direction", "debit"] }, "$amountKobo", 0] } },
        feesKobo: { $sum: "$feeKobo" },
        count: { $sum: 1 },
      },
    },
  ]);
  res.json({
    inflowKobo: totals?.inflowKobo ?? 0,
    outflowKobo: totals?.outflowKobo ?? 0,
    feesKobo: totals?.feesKobo ?? 0,
    count: totals?.count ?? 0,
    currency: "NGN",
  });
};

export const getTransaction: RequestHandler<IdParams> = async (req, res) => {
  if (!isValidObjectId(req.params.id)) throw new HttpError(400, "Invalid id");
  const transaction = await TransactionModel.findOne({ _id: req.params.id, business: req.business!._id });
  if (!transaction || (transaction.branch && !canAccessBranch(req.membership!, transaction.branch))) {
    throw new HttpError(404, "Transaction not found");
  }
  res.json((await serializeTransactions([transaction]))[0]);
};
