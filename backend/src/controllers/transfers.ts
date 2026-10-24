import type { Request, RequestHandler } from "express";
import { isValidObjectId, Types } from "mongoose";
import { z } from "zod";
import { BranchModel } from "../models/Branch";
import { TRANSFER_KINDS, TRANSFER_STATUSES, TransferBatchModel, TransferModel, type TransferDocument } from "../models/Transfer";
import { ROLE_LABELS } from "../config/permissions";
import { MembershipModel } from "../models/Membership";
import { UserModel } from "../models/User";
import {
  approvalBlocker,
  approvalPlan,
  awaitingFilter,
  canDecide,
  currentLevel,
  levelsOf,
  MAX_APPROVERS_PER_LEVEL,
  MAX_LEVELS,
  MAX_TIERS,
} from "../services/approvals";
import { beneficiaryRecipient, checkPayoutRows, findBeneficiary, keyedPayoutRows, resolvePayoutRows, saveBeneficiary } from "../services/beneficiaries";
import { branchScope, canAccessBranch, ensureOwnerMembership, hasPermission } from "../services/team";
import {
  cancelTransfers,
  createTransfers,
  decideBatchTransfers,
  decideTransfers,
  keyedBranchRow,
  listBanks,
  planForRequest,
  previewTransfers,
  quoteFee,
  refreshTransfer,
  replayBeforeLookups,
  resolveBankRecipient,
  resolveBankRecipients,
  resolveBranchRecipient,
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
  const userIds = transfers.flatMap((t) => [
    t.createdBy,
    t.decision?.by,
    ...levelsOf(t).flatMap((l) => [...l.approvers, l.approvedBy]),
  ].filter(Boolean));
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
      // The saved beneficiary paid, if any.
      beneficiary: t.recipient!.beneficiary ? String(t.recipient!.beneficiary) : null,
    },
    narration: t.narration ?? null,
    reference: t.reference,
    failureReason: t.failureReason ?? null,
    createdBy: user(t.createdBy),
    decision: t.decision?.by ? { by: user(t.decision.by), at: t.decision.at, note: t.decision.note ?? null } : null,
    approval: describeApproval(t, user),
    createdAt: t.get("createdAt"),
    submittedAt: t.submittedAt ?? null,
    completedAt: t.completedAt ?? null,
    canApprove: approvalBlocker(t, req.membership!, me) === null,
    canCancel: t.status === "pending_approval" && t.createdBy.equals(me),
  }));
}

type LevelStatus = "approved" | "waiting" | "upcoming" | "rejected" | "cancelled" | "not_reached";

/** The transfer's approval levels and where each stands, or null when it didn't need approval. */
function describeApproval(t: TransferDocument, user: (id?: Types.ObjectId | null) => { _id: string; name: string } | null) {
  const levels = levelsOf(t);
  if (!levels.length) return null;
  const current = currentLevel(t);
  const statusAt = (i: number): LevelStatus => {
    if (i < current) return "approved";
    if (i > current) return t.status === "pending_approval" ? "upcoming" : "not_reached";
    if (t.status === "pending_approval") return "waiting";
    if (t.status === "rejected") return "rejected";
    if (t.status === "cancelled") return "cancelled";
    return "approved";
  };
  return {
    current: t.status === "pending_approval" ? current + 1 : null, // 1-based level waiting for a decision
    levels: levels.map((l, i) => ({
      level: i + 1,
      // true: anyone who can approve transfers; otherwise one of `approvers`.
      any: l.any,
      approvers: l.approvers.map((id) => user(id)).filter(Boolean),
      status: statusAt(i),
      approvedBy: user(l.approvedBy),
      approvedAt: l.approvedAt ?? null,
      note: l.note ?? null,
    })),
  };
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

type BatchFields = {
  _id: Types.ObjectId;
  title?: string | null;
  payoutList?: Types.ObjectId | null;
  count: number;
  amountKobo: number;
  feeKobo: number;
  totalKobo: number;
  createdAt: Date;
};
type NamedBranch = { id: string; name: string; isHeadOffice: boolean } | null | undefined;
type NamedUser = { id: string; name: string } | null | undefined;

/** The fields a batch has both in the batch list and on its own. */
function batchHead(batch: BatchFields, branch: NamedBranch, creator: NamedUser) {
  return {
    _id: String(batch._id),
    title: batch.title ?? null,
    payoutList: batch.payoutList ? String(batch.payoutList) : null,
    // The account it's paid from and who sent it, in the same shapes as on each transfer, so a client needn't
    // read them from the first row.
    branch: branch ? { _id: branch.id, name: branch.name, isHeadOffice: branch.isHeadOffice } : null,
    createdBy: creator ? { _id: creator.id, name: creator.name } : null,
    count: batch.count,
    amountKobo: batch.amountKobo,
    feeKobo: batch.feeKobo,
    totalKobo: batch.totalKobo,
    createdAt: batch.createdAt,
  };
}

async function serializeBatch(req: Request, batch: InstanceType<typeof TransferBatchModel>, transfers: TransferDocument[]) {
  const [items, branch, creator] = await Promise.all([
    serialize(req, transfers),
    BranchModel.findById(batch.branch).select("name isHeadOffice"),
    UserModel.findById(batch.createdBy).select("name"),
  ]);
  const counts = Object.fromEntries(TRANSFER_STATUSES.map((s) => [s, items.filter((i) => i.status === s).length]));
  return {
    ...batchHead(batch.toObject() as BatchFields, branch, creator),
    statusCounts: counts,
    // Rows this member can approve or reject now, for "Approve N waiting for you".
    awaitingMe: transfers.filter((t) => canDecide(t, req.membership!, req.userId!)).length,
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

/**
 * Name enquiries for a bulk transfer's review: `{ items: [{ accountNumber, bankUuid }] }` (1–200 rows), and a
 * result per row in the same order, the account's name or why it can't be paid. Moves no money.
 */
export const resolveAccounts: RequestHandler = async (req, res) => {
  const body = z
    .object({
      // Checked per row (INVALID_ACCOUNT_NUMBER), so one typo doesn't fail the rest.
      items: z.array(z.object({ accountNumber: z.string().trim().max(20), bankUuid: z.string().trim().min(1).max(100) })).min(1).max(MAX_BULK_ITEMS),
    })
    .parse(req.body);
  const items = await resolveBankRecipients(req.business!, body.items);
  const failed = items.filter((i) => "error" in i).length;
  res.json({ items, resolved: items.length - failed, failed });
};

/**
 * Fee for one transfer of `amountKobo`, plus whether the signed-in member's transfer would need approval.
 * With `branch`, that counts what the member sent from the branch in the last 24 hours, as sending does.
 */
export const getFee: RequestHandler = async (req, res) => {
  const query = z.object({ amountKobo: z.coerce.number().pipe(amountKobo), branch: objectId.optional() }).parse(req.query);
  const fee = await quoteFee(query.amountKobo);
  let branchId: Types.ObjectId | undefined;
  if (query.branch) {
    const branch = await BranchModel.findOne({ _id: query.branch, business: req.business!._id }).select("_id");
    if (!branch || !canAccessBranch(req.membership!, branch._id)) throw new HttpError(404, "Branch not found");
    branchId = branch._id;
  }
  const { plan } = branchId
    ? await planForRequest({ business: req.business!, membership: req.membership!, userId: req.userId!, branchId, amountKobo: query.amountKobo })
    : { plan: approvalPlan(req.business!, req.membership!, query.amountKobo) };
  res.json({
    amountKobo: query.amountKobo,
    ...fee,
    totalKobo: query.amountKobo + fee.feeKobo,
    needsApproval: plan.length > 0,
    approvalLevels: plan.length,
  });
};

// ---------------------------------------------------------------------------------------------------------
// Approval rule
// ---------------------------------------------------------------------------------------------------------

/** Members of this business who can approve transfers, by user id, with their role and branches. */
async function approverDirectory(req: Request) {
  const business = req.business!;
  await ensureOwnerMembership(business);
  const memberships = await MembershipModel.find({ business: business._id });
  const approvers = memberships.filter((m) => hasPermission(m, "transfers.approve"));
  const [users, branches] = await Promise.all([
    UserModel.find({ _id: { $in: approvers.map((m) => m.user) } }).select("name email"),
    BranchModel.find({ business: business._id }).select("name"),
  ]);
  return approvers.flatMap((m) => {
    const u = users.find((x) => x._id.equals(m.user));
    if (!u) return [];
    const scope = branchScope(m);
    return [
      {
        _id: u.id as string,
        name: u.name,
        email: u.email,
        role: m.role,
        roleLabel: ROLE_LABELS[m.role],
        // null = every branch
        branches: scope ? branches.filter((b) => scope.some((id) => id.equals(b._id))).map((b) => ({ _id: b.id, name: b.name })) : null,
      },
    ];
  });
}

async function describeApprovalRule(req: Request) {
  const rule = req.business!.transferApproval;
  const mode = rule?.mode ?? "never";
  const tiers = mode === "workflow" ? [...(rule?.tiers ?? [])].sort((a, b) => a.minKobo - b.minKobo) : [];
  const directory = tiers.length ? await approverDirectory(req) : [];
  const ids = [...new Set(tiers.flatMap((t) => t.levels.flatMap((l) => l.approvers.map(String))))];
  const users = await UserModel.find({ _id: { $in: ids } }).select("name email");
  return {
    mode,
    thresholdKobo: rule?.thresholdKobo ?? null,
    tiers: tiers.map((t) => ({
      minKobo: t.minKobo,
      levels: t.levels.map((l) => ({
        approvers: l.approvers.map((id) => {
          const member = directory.find((d) => d._id === String(id));
          const u = users.find((x) => x._id.equals(id));
          return {
            _id: String(id),
            name: member?.name ?? u?.name ?? "Former member",
            role: member?.role ?? null,
            roleLabel: member?.roleLabel ?? null,
            // false once they've left or lost the right to approve; the level then relies on the others.
            canApprove: !!member,
          };
        }),
      })),
    })),
  };
}

export const getTransferSettings: RequestHandler = async (req, res) => {
  res.json({ approval: await describeApprovalRule(req) });
};

/** For the workflow editor: who can be named as an approver. */
export const listApprovers: RequestHandler = async (req, res) => {
  res.json(await approverDirectory(req));
};

const workflowTiers = z
  .array(
    z.object({
      minKobo: z.number().int().min(0),
      levels: z
        .array(z.object({ approvers: z.array(objectId).min(1).max(MAX_APPROVERS_PER_LEVEL) }))
        .min(1)
        .max(MAX_LEVELS),
    }),
  )
  .min(1)
  .max(MAX_TIERS);

export const updateTransferSettings: RequestHandler = async (req, res) => {
  const body = z
    .object({
      approval: z.discriminatedUnion("mode", [
        z.object({ mode: z.literal("never") }),
        z.object({ mode: z.literal("always") }),
        z.object({ mode: z.literal("above_threshold"), thresholdKobo: z.number().int().min(100) }),
        z.object({ mode: z.literal("workflow"), tiers: workflowTiers }),
      ]),
    })
    .parse(req.body);
  const business = req.business!;
  const approval = body.approval;

  let tiers: { minKobo: number; levels: { approvers: Types.ObjectId[] }[] }[] | undefined;
  if (approval.mode === "workflow") {
    const amounts = approval.tiers.map((t) => t.minKobo);
    if (new Set(amounts).size !== amounts.length) {
      throw new HttpError(400, "Two tiers start at the same amount", "INVALID_APPROVAL_RULE");
    }
    const directory = new Set((await approverDirectory(req)).map((d) => d._id));
    for (const tier of approval.tiers) {
      const named = tier.levels.flatMap((l) => l.approvers);
      if (new Set(named).size !== named.length) {
        throw new HttpError(400, "Each person can only be at one level of a tier", "DUPLICATE_APPROVER");
      }
      const outsider = named.find((id) => !directory.has(id));
      if (outsider) {
        throw new HttpError(400, "Approvers must be team members who can approve transfers", "INVALID_APPROVER", { userId: outsider });
      }
    }
    tiers = approval.tiers
      .sort((a, b) => a.minKobo - b.minKobo)
      .map((t) => ({ minKobo: t.minKobo, levels: t.levels.map((l) => ({ approvers: l.approvers.map((id) => new Types.ObjectId(id)) })) }));
  }

  business.set("transferApproval", {
    mode: approval.mode,
    thresholdKobo: approval.mode === "above_threshold" ? approval.thresholdKobo : undefined,
    tiers,
  });
  await business.save();
  res.json({ approval: await describeApprovalRule(req) });
};

// ---------------------------------------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------------------------------------

const listFilters = z.object({
  status: z.enum(TRANSFER_STATUSES).optional(),
  kind: z.enum(TRANSFER_KINDS).optional(),
  branch: objectId.optional(),
  batch: objectId.optional(),
  // Payments to one saved beneficiary.
  beneficiary: objectId.optional(),
  // "me": waiting for the signed-in member's approval at its current level.
  awaiting: z.literal("me").optional(),
  // Fund approvals tabs: waiting, approved (and sent), or declined.
  approval: z.enum(["pending", "approved", "rejected"]).optional(),
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
  if (f.beneficiary) filter["recipient.beneficiary"] = new Types.ObjectId(f.beneficiary);
  if (f.awaiting) {
    if (!hasPermission(req.membership!, "transfers.approve")) {
      return void res.json({ items: [], total: 0, skip: f.skip, take: f.take });
    }
    Object.assign(filter, awaitingFilter(req.userId!));
  }
  if (f.approval === "pending") filter.status = "pending_approval";
  if (f.approval === "rejected") filter.status = "rejected";
  if (f.approval === "approved") {
    filter["decision.by"] = { $exists: true };
    filter.status = f.status && ["processing", "success", "failed"].includes(f.status) ? f.status : { $in: ["processing", "success", "failed"] };
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
  z.object({ type: z.literal("beneficiary"), beneficiary: objectId }),
]);

/**
 * Sends money from one of the business's branch accounts. Send an Idempotency-Key header to retry safely.
 * `saveBeneficiary: true` adds a new bank recipient to the saved beneficiaries.
 */
export const createTransfer: RequestHandler = async (req, res) => {
  const body = z
    .object({ branch: objectId, amountKobo, narration, recipient: recipientInput, saveBeneficiary: z.boolean().optional() })
    .parse(req.body);
  const business = req.business!;
  const key = clientKey(req);
  // A retry is answered before the bank is asked about the recipient again, so it still works while the bank is down.
  const early = await replayBeforeLookups({
    business,
    membership: req.membership!,
    userId: req.userId!,
    branchId: body.branch,
    clientKey: key,
    rows: async () => {
      const { recipient: r, amountKobo, narration } = body;
      if (r.type === "branch") {
        const row = await keyedBranchRow(business, r.branch, { amountKobo, narration });
        return row && [row];
      }
      const row = r.type === "bank" ? { accountNumber: r.accountNumber, bankUuid: r.bankUuid, amountKobo, narration } : { beneficiary: r.beneficiary, amountKobo, narration };
      return keyedPayoutRows(business, [row], { save: body.saveBeneficiary });
    },
  });
  if (early) return void res.status(200).json((await serialize(req, early.transfers.slice(0, 1)))[0]);

  let beneficiary: Types.ObjectId | undefined;
  let recipient;
  if (body.recipient.type === "branch") {
    recipient = await resolveBranchRecipient(business, body.recipient.branch);
  } else if (body.recipient.type === "beneficiary") {
    const saved = await findBeneficiary(business, body.recipient.beneficiary);
    recipient = await beneficiaryRecipient(business, saved);
    beneficiary = saved._id;
  } else {
    recipient = await resolveBankRecipient(business, body.recipient.accountNumber, body.recipient.bankUuid);
  }
  if (body.saveBeneficiary && !beneficiary && recipient.kind !== "internal") {
    beneficiary = (await saveBeneficiary(business, req.userId!, recipient)).beneficiary._id;
  }

  const { transfers, replayed } = await createTransfers({
    business,
    membership: req.membership!,
    userId: req.userId!,
    branchId: body.branch,
    requests: [{ recipient, amountKobo: body.amountKobo, narration: body.narration, beneficiary }],
    clientKey: key,
  });
  res.status(replayed ? 200 : 201).json((await serialize(req, transfers.slice(0, 1)))[0]);
};

export const MAX_BULK_ITEMS = 200;

// The account name the member reviewed (resolve-accounts or the preview). Optional; when sent, a row whose
// account is now under a different name is refused with ACCOUNT_NAME_CHANGED.
export const reviewedName = z.string().trim().min(1).max(200).optional();

/** A bulk row: a saved beneficiary, or an account number and bank. */
export const payoutRow = z.union([
  z.object({ beneficiary: objectId, amountKobo, narration, accountName: reviewedName }),
  z.object({ accountNumber, bankUuid: z.string().trim().min(1), amountKobo, narration, accountName: reviewedName }),
]);

const bulkBody = z.object({
  branch: objectId,
  title: z.string().trim().max(80).optional(),
  items: z.array(payoutRow).min(1).max(MAX_BULK_ITEMS),
  saveBeneficiaries: z.boolean().optional(),
});

/**
 * Several transfers from one account at once. Every row is checked first; if any row fails, nothing is
 * created and the errors come back per row (`details.rows`). `saveBeneficiaries: true` saves the new accounts.
 */
export const createBulkTransfer: RequestHandler = async (req, res) => {
  const body = bulkBody.parse(req.body);
  const business = req.business!;
  const key = clientKey(req);
  // A retry is answered before every row's name enquiry, so it still works while the bank is down.
  const early = await replayBeforeLookups({
    business,
    membership: req.membership!,
    userId: req.userId!,
    branchId: body.branch,
    clientKey: key,
    rows: () => keyedPayoutRows(business, body.items, { save: body.saveBeneficiaries }),
  });
  if (early) return void res.status(200).json(await describeBulkResult(req, early.transfers, early.batch));

  const requests = await resolvePayoutRows(business, body.items, { save: body.saveBeneficiaries, userId: req.userId! });
  const { transfers, batch, replayed } = await createTransfers({
    business,
    membership: req.membership!,
    userId: req.userId!,
    branchId: body.branch,
    requests,
    batchTitle: body.title,
    clientKey: key,
  });
  res.status(replayed ? 200 : 201).json(await describeBulkResult(req, transfers, batch));
};

/**
 * A dry run of POST /bulk with the same body (no Idempotency-Key): each row's fee and errors, the totals, the
 * available balance and the approval the batch would get. Creates nothing, holds no money and takes no lock.
 */
export const previewBulkTransfer: RequestHandler = async (req, res) => {
  const body = bulkBody.parse(req.body);
  const { requests, errors } = await checkPayoutRows(req.business!, body.items, { cached: true });
  res.json(
    await previewTransfers({
      business: req.business!,
      membership: req.membership!,
      userId: req.userId!,
      branchId: body.branch,
      rows: body.items,
      requests,
      errors,
    }),
  );
};

/** `{ batch }` for several rows; `{ batch: null, items }` when a single row became a plain transfer. */
export async function describeBulkResult(req: Request, transfers: TransferDocument[], batch: InstanceType<typeof TransferBatchModel> | null) {
  const savedBatch = batch ?? (transfers[0]?.batch ? await TransferBatchModel.findById(transfers[0].batch) : null);
  if (!savedBatch) return { batch: null, items: await serialize(req, transfers) };
  return { batch: await serializeBatch(req, savedBatch, transfers) };
}

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

const batchFilters = z.object({
  branch: objectId.optional(),
  // "me": batches with at least one row the signed-in member can approve or reject now.
  awaiting: z.literal("me").optional(),
  // Fund approvals tabs: batches with at least one row in the tab, as on the transfers list.
  approval: z.enum(["pending", "approved", "rejected"]).optional(),
  skip: z.coerce.number().int().min(0).default(0),
  take: z.coerce.number().int().min(1).max(100).default(20),
});

/** What a row must match for its batch to be in a Fund approvals tab (the same meanings as `GET /?approval=`). */
const APPROVAL_TABS = {
  pending: { status: "pending_approval" },
  approved: { "decision.by": { $exists: true }, status: { $in: ["processing", "success", "failed"] } },
  rejected: { status: "rejected" },
};

// A waiting row's 1-based level and how many levels it has (transfers from before levels had one); null otherwise.
const isWaiting = { $eq: ["$status", "pending_approval"] };
const waitingLevel = {
  level: { $cond: [isWaiting, { $add: [{ $ifNull: ["$approval.current", 0] }, 1] }, null] },
  of: { $cond: [isWaiting, { $max: [{ $size: { $ifNull: ["$approval.levels", []] } }, 1] }, null] },
};

type BatchSummaryRow = BatchFields & {
  branch: Types.ObjectId;
  createdBy: Types.ObjectId;
  rows: { _id: { status: string; level: number | null; of: number | null }; n: number }[];
  mine?: { _id: { level: number; of: number }; n: number }[];
};

/**
 * Batches, newest first, each with its totals, row counts by status, how many rows wait for the signed-in
 * member, and the levels its waiting rows are at. `?branch=&approval=&awaiting=me&skip=&take=`
 */
export const listBatches: RequestHandler = async (req, res) => {
  const f = batchFilters.parse(req.query);
  const membership = req.membership!;
  if (f.branch && !canAccessBranch(membership, f.branch)) throw new HttpError(404, "Branch not found");
  const canApprove = hasPermission(membership, "transfers.approve");
  if (f.awaiting && !canApprove) return void res.json({ items: [], total: 0, skip: f.skip, take: f.take });
  const scope = branchScope(membership);
  const match: Record<string, unknown> = { business: req.business!._id };
  if (f.branch) match.branch = new Types.ObjectId(f.branch);
  else if (scope) match.branch = { $in: scope };

  const transfers = TransferModel.collection.collectionName;
  const mine = awaitingFilter(req.userId!);
  // Keeps the batches with at least one row matching `rows`; each lookup stops at the first such row.
  const having = (rows: Record<string, unknown>, as: string) => [
    { $lookup: { from: transfers, localField: "_id", foreignField: "batch", pipeline: [{ $match: rows }, { $limit: 1 }, { $project: { _id: 1 } }], as } },
    { $match: { [`${as}.0`]: { $exists: true } } },
  ];

  // One aggregation: filter and page the batches, then count the rows of only the page's batches.
  const [result] = await TransferBatchModel.aggregate<{ total: { n: number }[]; items: BatchSummaryRow[] }>([
    { $match: match },
    { $sort: { createdAt: -1, _id: -1 } },
    ...(f.approval ? having(APPROVAL_TABS[f.approval], "inTab") : []),
    ...(f.awaiting ? having(mine, "forMe") : []),
    {
      $facet: {
        total: [{ $count: "n" }],
        items: [
          { $skip: f.skip },
          { $limit: f.take },
          {
            $lookup: {
              from: transfers,
              localField: "_id",
              foreignField: "batch",
              pipeline: [{ $group: { _id: { status: "$status", ...waitingLevel }, n: { $sum: 1 } } }],
              as: "rows",
            },
          },
          // Nothing waits for someone who can't approve, so their count needs no lookup.
          ...(canApprove
            ? [
                {
                  $lookup: {
                    from: transfers,
                    localField: "_id",
                    foreignField: "batch",
                    pipeline: [{ $match: mine }, { $group: { _id: waitingLevel, n: { $sum: 1 } } }],
                    as: "mine",
                  },
                },
              ]
            : []),
          { $project: { inTab: 0, forMe: 0 } },
        ],
      },
    },
  ]);
  const rows = result?.items ?? [];

  const [branches, users] = await Promise.all([
    BranchModel.find({ _id: { $in: rows.map((b) => b.branch) } }).select("name isHeadOffice"),
    UserModel.find({ _id: { $in: rows.map((b) => b.createdBy) } }).select("name"),
  ]);
  const items = rows.map((b) => {
    const statusCounts: Record<string, number> = Object.fromEntries(TRANSFER_STATUSES.map((s) => [s, 0]));
    for (const g of b.rows) statusCounts[g._id.status] = (statusCounts[g._id.status] ?? 0) + g.n;
    const mineAt = (level: number, of: number) => (b.mine ?? []).find((m) => m._id.level === level && m._id.of === of)?.n ?? 0;
    return {
      ...batchHead(
        b,
        branches.find((x) => x._id.equals(b.branch)),
        users.find((x) => x._id.equals(b.createdBy)),
      ),
      statusCounts,
      awaitingMe: (b.mine ?? []).reduce((sum, m) => sum + m.n, 0),
      // Where the waiting rows are, lowest level first: enough for "Level 1 of 2 · 3 waiting for you".
      levels: b.rows
        .filter((g) => g._id.level !== null)
        .map((g) => ({ level: g._id.level!, of: g._id.of!, waiting: g.n, awaitingMe: mineAt(g._id.level!, g._id.of!) }))
        .sort((x, y) => x.level - y.level || x.of - y.of),
    };
  });
  res.json({ items, total: result?.total[0]?.n ?? 0, skip: f.skip, take: f.take });
};

export const getBatch: RequestHandler<IdParams> = async (req, res) => {
  const { batch, transfers } = await findBatch(req, req.params.id);
  res.json(await serializeBatch(req, batch, transfers));
};

/**
 * Approves or rejects the rows waiting for the signed-in member and leaves the rest. Answers with the batch plus
 * `decided` (rows this request approved a level of, or rejected) and `skipped` (rows that were waiting but
 * weren't decided here: other levels or approvers, or decided by someone else at the same moment).
 */
const decideBatch =
  (decision: "approve" | "reject"): RequestHandler<IdParams> =>
  async (req, res) => {
    const { note: text } = note.parse(req.body ?? {});
    const { batch, transfers } = await findBatch(req, req.params.id);
    const { decided, skipped } = await decideBatchTransfers({ transfers, membership: req.membership!, userId: req.userId!, decision, note: text });
    const batchNow = await serializeBatch(req, batch, await TransferModel.find({ batch: batch._id }).sort({ _id: 1 }));
    res.json({ ...batchNow, decided, skipped });
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
