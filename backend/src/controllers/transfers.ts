import type { Request, RequestHandler, Response } from "express";
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
  currentLevel,
  levelsOf,
  MAX_APPROVERS_PER_LEVEL,
  MAX_LEVELS,
  MAX_TIERS,
} from "../services/approvals";
import { beneficiaryRecipient, findBeneficiary, resolvePayoutRows, saveBeneficiary } from "../services/beneficiaries";
import { branchScope, canAccessBranch, ensureOwnerMembership, hasPermission } from "../services/team";
import {
  cancelTransfers,
  createTransfers,
  decideTransfers,
  listBanks,
  quoteFee,
  refreshTransfer,
  resolveBankRecipient,
  resolveBranchRecipient,
} from "../services/transfers";
import { withStepUp } from "../services/stepUp";
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

export async function serialize(req: Request, transfers: TransferDocument[]) {
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
      // Set on withdrawals to one of the business's settlement accounts.
      settlementAccount: t.recipient!.settlementAccount ? String(t.recipient!.settlementAccount) : null,
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

async function serializeBatch(req: Request, batch: InstanceType<typeof TransferBatchModel>, transfers: TransferDocument[]) {
  const items = await serialize(req, transfers);
  const counts = Object.fromEntries(TRANSFER_STATUSES.map((s) => [s, items.filter((i) => i.status === s).length]));
  return {
    _id: batch.id,
    title: batch.title ?? null,
    payoutList: batch.payoutList ? String(batch.payoutList) : null,
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
  const plan = approvalPlan(req.business!, req.membership!, query.amountKobo);
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
    const me = new Types.ObjectId(req.userId);
    filter.status = "pending_approval";
    filter.createdBy = { $ne: me };
    filter["approval.levels.approvedBy"] = { $ne: me };
    filter.$and = [
      { $or: [{ "approval.waitingOn": me }, { "approval.waitingOnAny": true }, { "approval.levels.0": { $exists: false } }] },
    ];
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
 * `saveBeneficiary: true` adds a new bank recipient to the saved beneficiaries. Needs a step-up
 * (`transfer.create`), except between the business's own branches.
 */
export const createTransfer: RequestHandler = async (req, res) => {
  const body = z
    .object({ branch: objectId, amountKobo, narration, recipient: recipientInput, saveBeneficiary: z.boolean().optional() })
    .parse(req.body);
  if (body.recipient.type === "branch") return void (await sendTransfer(req, res, body));
  await withStepUp(req, "transfer.create", body, () => sendTransfer(req, res, body));
};

async function sendTransfer(
  req: Request,
  res: Response,
  body: { branch: string; amountKobo: number; narration?: string; recipient: z.infer<typeof recipientInput>; saveBeneficiary?: boolean },
) {
  const business = req.business!;
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
    clientKey: clientKey(req),
  });
  res.status(replayed ? 200 : 201).json((await serialize(req, transfers.slice(0, 1)))[0]);
}

export const MAX_BULK_ITEMS = 200;

/** A bulk row: a saved beneficiary, or an account number and bank. */
export const payoutRow = z.union([
  z.object({ beneficiary: objectId, amountKobo, narration }),
  z.object({ accountNumber, bankUuid: z.string().trim().min(1), amountKobo, narration }),
]);

/**
 * Several transfers from one account at once. Every row is checked first; if any row fails, nothing is
 * created and the errors come back per row (`details.rows`). `saveBeneficiaries: true` saves the new accounts.
 */
export const createBulkTransfer: RequestHandler = async (req, res) => {
  const body = z
    .object({
      branch: objectId,
      title: z.string().trim().max(80).optional(),
      items: z.array(payoutRow).min(1).max(MAX_BULK_ITEMS),
      saveBeneficiaries: z.boolean().optional(),
    })
    .parse(req.body);
  const business = req.business!;
  await withStepUp(req, "transfer.bulk", body, async () => {
    const requests = await resolvePayoutRows(business, body.items, { save: body.saveBeneficiaries, userId: req.userId! });
    const { transfers, batch, replayed } = await createTransfers({
      business,
      membership: req.membership!,
      userId: req.userId!,
      branchId: body.branch,
      requests,
      batchTitle: body.title,
      clientKey: clientKey(req),
    });
    res.status(replayed ? 200 : 201).json(await describeBulkResult(req, transfers, batch));
  });
};

/** `{ batch }` for several rows; `{ batch: null, items }` when a single row became a plain transfer. */
export async function describeBulkResult(req: Request, transfers: TransferDocument[], batch: InstanceType<typeof TransferBatchModel> | null) {
  const savedBatch = batch ?? (transfers[0]?.batch ? await TransferBatchModel.findById(transfers[0].batch) : null);
  if (!savedBatch) return { batch: null, items: await serialize(req, transfers) };
  return { batch: await serializeBatch(req, savedBatch, transfers) };
}

/** Needs a step-up (`transfer.approve` with `{ id }`). */
export const approveTransfer: RequestHandler<IdParams> = async (req, res) => {
  const { note: text } = note.parse(req.body ?? {});
  const transfer = await findTransfer(req, req.params.id);
  await withStepUp(req, "transfer.approve", { id: req.params.id }, async () => {
    const [decided] = await decideTransfers({ transfers: [transfer], membership: req.membership!, userId: req.userId!, decision: "approve", note: text });
    res.json((await serialize(req, [decided ?? (await findTransfer(req, req.params.id))]))[0]);
  });
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
    const decide = async () => {
      await decideTransfers({ transfers: pending, membership: req.membership!, userId: req.userId!, decision, note: text });
      res.json(await serializeBatch(req, batch, await TransferModel.find({ batch: batch._id }).sort({ _id: 1 })));
    };
    // Approving needs a step-up (`batch.approve` with `{ id }`); rejecting doesn't.
    if (decision === "approve") await withStepUp(req, "batch.approve", { id: req.params.id }, decide);
    else await decide();
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
