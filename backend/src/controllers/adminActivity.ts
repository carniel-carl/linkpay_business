// What a business is doing, for staff: money in and out, transfers, team and sign-ins, plus a
// platform-wide feed of payments. Read only; nothing here calls Liquifia except read-only balance lookups.
import type { RequestHandler } from "express";
import { isValidObjectId, Types } from "mongoose";
import { z } from "zod";
import { ROLE_LABELS } from "../config/permissions";
import { BranchModel } from "../models/Branch";
import { BusinessModel } from "../models/Business";
import { InviteModel } from "../models/Invite";
import { MembershipModel } from "../models/Membership";
import { SessionModel } from "../models/Session";
import { TRANSACTION_STATUSES, TransactionModel } from "../models/Transaction";
import { TRANSFER_KINDS, TRANSFER_STATUSES, TransferModel, type TransferDocument } from "../models/Transfer";
import { UserModel } from "../models/User";
import { VirtualAccountModel } from "../models/VirtualAccount";
import { liquifia } from "../services/liquifia/client";
import { HttpError } from "../utils/HttpError";
import { serializeTransactions } from "./transactions";

type IdParams = { id: string };

const DAY = 24 * 60 * 60 * 1000;
const objectId = z.string().refine(isValidObjectId, "Invalid id");
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const paging = { skip: z.coerce.number().int().min(0).default(0), take: z.coerce.number().int().min(1).max(100).default(25) };

async function findBusiness(id: string) {
  if (!isValidObjectId(id)) throw new HttpError(400, "Invalid id");
  const business = await BusinessModel.findById(id);
  if (!business) throw new HttpError(404, "Business not found");
  return business;
}

// ---------------------------------------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------------------------------------

/** Balances, money in and out over a day, a week and 30 days, a daily chart, transfers and the team. */
export const getBusinessActivity: RequestHandler<IdParams> = async (req, res) => {
  const business = await findBusiness(req.params.id);
  const now = Date.now();
  const day = new Date(now - DAY);
  const week = new Date(now - 7 * DAY);
  const month = new Date(now - 30 * DAY);
  const id = business._id;

  const sumSince = (since: Date) => ({
    $sum: { $cond: [{ $gte: ["$occurredAt", since] }, "$amountKobo", 0] },
  });
  const countSince = (since: Date) => ({ $sum: { $cond: [{ $gte: ["$occurredAt", since] }, 1, 0] } });

  const [flows, daily, transferCounts, counterparties, accounts, memberCount, lastTx] = await Promise.all([
    TransactionModel.aggregate<{ _id: "credit" | "debit"; day: number; dayCount: number; week: number; weekCount: number; month: number; monthCount: number }>([
      // Money in: successful payments. Money out: payouts the bank partner accepted (pending or settled).
      { $match: { business: id, occurredAt: { $gte: month }, $or: [{ direction: "credit", status: "success" }, { direction: "debit", status: { $in: ["pending", "success"] } }] } },
      {
        $group: {
          _id: "$direction",
          day: sumSince(day),
          dayCount: countSince(day),
          week: sumSince(week),
          weekCount: countSince(week),
          month: { $sum: "$amountKobo" },
          monthCount: { $sum: 1 },
        },
      },
    ]),
    TransactionModel.aggregate<{ _id: string; inKobo: number; outKobo: number }>([
      { $match: { business: id, occurredAt: { $gte: month }, $or: [{ direction: "credit", status: "success" }, { direction: "debit", status: { $in: ["pending", "success"] } }] } },
      {
        $group: {
          _id: { $dateToString: { date: "$occurredAt", format: "%Y-%m-%d", timezone: "Africa/Lagos" } },
          inKobo: { $sum: { $cond: [{ $eq: ["$direction", "credit"] }, "$amountKobo", 0] } },
          outKobo: { $sum: { $cond: [{ $eq: ["$direction", "debit"] }, "$amountKobo", 0] } },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    TransferModel.aggregate<{ _id: string; count: number; kobo: number }>([
      { $match: { business: id, createdAt: { $gte: month } } },
      { $group: { _id: "$status", count: { $sum: 1 }, kobo: { $sum: "$amountKobo" } } },
    ]),
    Promise.all([
      TransactionModel.distinct("counterparty.accountNumber", { business: id, direction: "credit", occurredAt: { $gte: month } }),
      TransferModel.distinct("recipient.accountNumber", { business: id, kind: { $ne: "internal" }, createdAt: { $gte: month } }),
    ]),
    VirtualAccountModel.find({ business: id }).sort({ createdAt: 1 }),
    MembershipModel.countDocuments({ business: id }),
    TransactionModel.findOne({ business: id }).sort({ occurredAt: -1 }).select("occurredAt"),
  ]);

  const branches = await BranchModel.find({ business: id }).select("name isHeadOffice");
  // Read-only balance lookups; a failure shows as null rather than failing the page.
  const balances = await Promise.all(
    accounts.map((a) =>
      liquifia
        .getVirtualAccountBalance(a.providerAccountId)
        .then((b) => Math.round(b.balance))
        .catch(() => null),
    ),
  );

  const flow = (direction: "credit" | "debit") => {
    const f = flows.find((x) => x._id === direction);
    return {
      last24h: { kobo: f?.day ?? 0, count: f?.dayCount ?? 0 },
      last7d: { kobo: f?.week ?? 0, count: f?.weekCount ?? 0 },
      last30d: { kobo: f?.month ?? 0, count: f?.monthCount ?? 0 },
    };
  };

  res.json({
    business: { _id: business.id, name: business.name, status: business.status, compliance: business.compliance?.status ?? "active" },
    moneyIn: flow("credit"),
    moneyOut: flow("debit"),
    daily: daily.map((d) => ({ day: d._id, inKobo: d.inKobo, outKobo: d.outKobo })),
    transfers: {
      last30d: Object.fromEntries(
        TRANSFER_STATUSES.map((s) => {
          const row = transferCounts.find((r) => r._id === s);
          return [s, { count: row?.count ?? 0, kobo: row?.kobo ?? 0 }];
        }),
      ),
    },
    counterparties: { payers30d: counterparties[0].filter(Boolean).length, recipients30d: counterparties[1].length },
    accounts: accounts.map((a, i) => {
      const branch = branches.find((b) => a.branch && b._id.equals(a.branch));
      return {
        _id: a.id,
        accountNumber: a.accountNumber,
        accountName: a.accountName ?? null,
        bankName: a.bankName ?? null,
        branch: branch ? { _id: branch.id, name: branch.name, isHeadOffice: branch.isHeadOffice } : null,
        balanceKobo: balances[i],
      };
    }),
    team: { members: Math.max(memberCount, 1) },
    lastActivityAt: lastTx?.occurredAt ?? null,
  });
};

// ---------------------------------------------------------------------------------------------------------
// Transactions and transfers of one business
// ---------------------------------------------------------------------------------------------------------

const transactionFilters = z.object({
  branch: objectId.optional(),
  direction: z.enum(["credit", "debit"]).optional(),
  status: z.enum(TRANSACTION_STATUSES).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  minKobo: z.coerce.number().int().min(0).optional(),
  q: z.string().trim().max(100).optional(),
});

function transactionFilter(f: z.infer<typeof transactionFilters>) {
  const filter: Record<string, unknown> = {};
  if (f.branch) filter.branch = new Types.ObjectId(f.branch);
  if (f.direction) filter.direction = f.direction;
  if (f.status) filter.status = f.status;
  if (f.minKobo) filter.amountKobo = { $gte: f.minKobo };
  if (f.from || f.to) filter.occurredAt = { ...(f.from && { $gte: f.from }), ...(f.to && { $lte: f.to }) };
  if (f.q) {
    const re = new RegExp(escapeRegex(f.q), "i");
    filter.$or = [{ "counterparty.name": re }, { narration: re }, { reference: re }, { "counterparty.accountNumber": re }];
  }
  return filter;
}

/** `?branch=&direction=&status=&from=&to=&minKobo=&q=&skip=&take=`, newest first. */
export const listBusinessTransactions: RequestHandler<IdParams> = async (req, res) => {
  const business = await findBusiness(req.params.id);
  const query = transactionFilters.extend(paging).parse(req.query);
  const filter = { ...transactionFilter(query), business: business._id };
  const [items, total] = await Promise.all([
    TransactionModel.find(filter).sort({ occurredAt: -1, _id: -1 }).skip(query.skip).limit(query.take),
    TransactionModel.countDocuments(filter),
  ]);
  res.json({ items: await serializeTransactions(items), total, skip: query.skip, take: query.take });
};

/** Transfers as staff see them: who created and decided them, and whether one is held. */
export async function serializeAdminTransfers(transfers: TransferDocument[]) {
  const userIds = transfers.flatMap((t) => [t.createdBy, t.decision?.by].filter(Boolean));
  const branchIds = transfers.flatMap((t) => [t.branch, t.recipient?.branch].filter(Boolean));
  const [users, branches] = await Promise.all([
    UserModel.find({ _id: { $in: userIds } }).select("name email"),
    BranchModel.find({ _id: { $in: branchIds } }).select("name isHeadOffice"),
  ]);
  const user = (id?: Types.ObjectId | null) => {
    const u = id && users.find((x) => x._id.equals(id));
    return u ? { _id: u.id as string, name: u.name, email: u.email } : null;
  };
  const branch = (id?: Types.ObjectId | null) => {
    const b = id && branches.find((x) => x._id.equals(id));
    return b ? { _id: b.id as string, name: b.name, isHeadOffice: b.isHeadOffice } : null;
  };
  return transfers.map((t) => ({
    _id: t.id as string,
    business: String(t.business),
    kind: t.kind,
    status: t.status,
    amountKobo: t.amountKobo,
    feeKobo: t.feeKobo,
    totalKobo: t.totalKobo,
    currency: t.currency,
    branch: branch(t.branch),
    batch: t.batch ? String(t.batch) : null,
    recipient: {
      accountNumber: t.recipient!.accountNumber,
      accountName: t.recipient!.accountName,
      bankName: t.recipient!.bankName ?? null,
      // Set when the recipient is another business on LinkPay (or a branch of this one).
      business: t.recipient?.business ? String(t.recipient.business) : null,
      branch: t.kind === "internal" ? branch(t.recipient!.branch) : null,
    },
    narration: t.narration ?? null,
    reference: t.reference,
    failureReason: t.failureReason ?? null,
    // Approved but not yet accepted by the bank partner (e.g. held while the business is suspended).
    awaitingProvider: t.status === "processing" && !t.provider?.payoutId,
    providerError: t.provider?.lastError ?? null,
    createdBy: user(t.createdBy),
    decision: t.decision?.by ? { by: user(t.decision.by), at: t.decision.at, note: t.decision.note ?? null } : null,
    createdAt: t.get("createdAt") as Date,
    submittedAt: t.submittedAt ?? null,
    completedAt: t.completedAt ?? null,
  }));
}

/** `?status=&kind=&branch=&from=&to=&minKobo=&q=&skip=&take=`, newest first. */
export const listBusinessTransfers: RequestHandler<IdParams> = async (req, res) => {
  const business = await findBusiness(req.params.id);
  const query = z
    .object({
      status: z.enum(TRANSFER_STATUSES).optional(),
      kind: z.enum(TRANSFER_KINDS).optional(),
      branch: objectId.optional(),
      from: z.coerce.date().optional(),
      to: z.coerce.date().optional(),
      minKobo: z.coerce.number().int().min(0).optional(),
      q: z.string().trim().max(100).optional(),
      ...paging,
    })
    .parse(req.query);
  const filter: Record<string, unknown> = { business: business._id };
  if (query.status) filter.status = query.status;
  if (query.kind) filter.kind = query.kind;
  if (query.branch) filter.branch = new Types.ObjectId(query.branch);
  if (query.minKobo) filter.amountKobo = { $gte: query.minKobo };
  if (query.from || query.to) filter.createdAt = { ...(query.from && { $gte: query.from }), ...(query.to && { $lte: query.to }) };
  if (query.q) {
    const re = new RegExp(escapeRegex(query.q), "i");
    filter.$or = [{ "recipient.accountName": re }, { "recipient.accountNumber": re }, { narration: re }, { reference: re }];
  }
  const [items, total] = await Promise.all([
    TransferModel.find(filter).sort({ createdAt: -1, _id: -1 }).skip(query.skip).limit(query.take),
    TransferModel.countDocuments(filter),
  ]);
  res.json({ items: await serializeAdminTransfers(items), total, skip: query.skip, take: query.take });
};

// ---------------------------------------------------------------------------------------------------------
// Team
// ---------------------------------------------------------------------------------------------------------

/** Everyone on the business's team, with their last sign-in and signed-in phones, plus open invites. */
export const listBusinessMembers: RequestHandler<IdParams> = async (req, res) => {
  const business = await findBusiness(req.params.id);
  const memberships = await MembershipModel.find({ business: business._id }).sort({ createdAt: 1 });
  // The owner's membership is created lazily; include the owner either way.
  const userIds = [...new Set([String(business.owner), ...memberships.map((m) => String(m.user))])];
  const [users, branches, devices, invites] = await Promise.all([
    UserModel.find({ _id: { $in: userIds } }).select("name email emailVerified twoFactor.enabled twoFactor.method lastSignInAt lastSignInIp createdAt"),
    BranchModel.find({ business: business._id }).select("name"),
    SessionModel.aggregate<{ _id: Types.ObjectId; count: number }>([
      { $match: { user: { $in: userIds.map((u) => new Types.ObjectId(u)) }, revokedAt: null, expiresAt: { $gt: new Date() } } },
      { $group: { _id: "$user", count: { $sum: 1 } } },
    ]),
    InviteModel.find({ business: business._id, status: "pending", expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 }),
  ]);
  const members = userIds.flatMap((userId) => {
    const user = users.find((u) => u.id === userId);
    if (!user) return [];
    const m = memberships.find((x) => String(x.user) === userId);
    const role = m?.role ?? "owner";
    return [
      {
        user: {
          _id: user.id as string,
          name: user.name,
          email: user.email,
          emailVerified: user.emailVerified,
          twoFactor: user.twoFactor?.enabled ? user.twoFactor.method : null,
          lastSignInAt: user.lastSignInAt ?? null,
          lastSignInIp: user.lastSignInIp ?? null,
          createdAt: user.get("createdAt") as Date,
        },
        role,
        roleLabel: ROLE_LABELS[role],
        branches: (m?.branches ?? []).map((b) => ({ _id: String(b), name: branches.find((x) => x._id.equals(b))?.name ?? null })),
        joinedAt: m?.get("createdAt") ?? business.get("createdAt"),
        activeDevices: devices.find((d) => String(d._id) === userId)?.count ?? 0,
      },
    ];
  });
  res.json({
    members,
    invites: invites.map((i) => ({ _id: i.id as string, email: i.email, role: i.role, roleLabel: ROLE_LABELS[i.role], expiresAt: i.expiresAt, createdAt: i.get("createdAt") })),
  });
};

// ---------------------------------------------------------------------------------------------------------
// Platform-wide
// ---------------------------------------------------------------------------------------------------------

/** Every business's payments, newest first. `?business=&direction=&status=&from=&to=&minKobo=&q=&skip=&take=`. */
export const listPlatformTransactions: RequestHandler = async (req, res) => {
  const query = transactionFilters.omit({ branch: true }).extend({ business: objectId.optional(), ...paging }).parse(req.query);
  const filter = { ...transactionFilter(query), ...(query.business && { business: new Types.ObjectId(query.business) }) };
  const [items, total] = await Promise.all([
    TransactionModel.find(filter).sort({ occurredAt: -1, _id: -1 }).skip(query.skip).limit(query.take),
    TransactionModel.countDocuments(filter),
  ]);
  const businesses = await BusinessModel.find({ _id: { $in: [...new Set(items.map((t) => String(t.business)))] } }).select(
    "name compliance.status compliance.openFlags",
  );
  const serialized = await serializeTransactions(items);
  res.json({
    items: serialized.map((t, i) => {
      const b = businesses.find((x) => x._id.equals(items[i]!.business));
      return {
        ...t,
        business: b ? { _id: b.id as string, name: b.name, compliance: b.compliance?.status ?? "active", openFlags: b.compliance?.openFlags ?? 0 } : null,
      };
    }),
    total,
    skip: query.skip,
    take: query.take,
  });
};
