import type { Request, RequestHandler } from "express";
import { isValidObjectId, Types } from "mongoose";
import { z } from "zod";
import {
  SAFELOCK_MAX_AMOUNT_KOBO,
  SAFELOCK_MAX_DAYS,
  SAFELOCK_MAX_PER_BRANCH,
  SAFELOCK_MIN_AMOUNT_KOBO,
  SAFELOCK_MIN_DAYS,
} from "../config/safelock";
import { BranchModel } from "../models/Branch";
import { SAFELOCK_STATUSES, SafelockModel, type SafelockDocument } from "../models/Safelock";
import { UserModel } from "../models/User";
import { todayInLagos } from "../services/pockets";
import { createSafelock, daysBetween, releaseDueSafelocks, unlockWindow } from "../services/safelocks";
import { branchScope, canAccessBranch, hasPermission } from "../services/team";
import { HttpError } from "../utils/HttpError";

type IdParams = { id: string };

const objectId = z.string().refine(isValidObjectId, "Invalid id");
const title = z.string().trim().min(1, "Give the Safelock a name").max(40);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

function clientKey(req: Request) {
  const key = req.header("idempotency-key")?.trim();
  if (key && !/^[A-Za-z0-9_-]{8,100}$/.test(key)) throw new HttpError(400, "Invalid Idempotency-Key header");
  return key || undefined;
}

// ---------------------------------------------------------------------------------------------------------

async function serialize(req: Request, locks: SafelockDocument[]) {
  const [users, branches] = await Promise.all([
    UserModel.find({ _id: { $in: locks.map((l) => l.createdBy) } }).select("name"),
    BranchModel.find({ _id: { $in: locks.map((l) => l.branch) } }).select("name isHeadOffice"),
  ]);
  const canManage = hasPermission(req.membership!, "savings.manage");
  const today = todayInLagos();
  return locks.map((l) => {
    const u = users.find((x) => x._id.equals(l.createdBy));
    const b = branches.find((x) => x._id.equals(l.branch));
    const lockedOn = todayInLagos(l.get("createdAt"));
    const totalDays = daysBetween(lockedOn, l.unlockOn);
    const daysLeft = l.status === "locked" ? Math.max(0, daysBetween(today, l.unlockOn)) : 0;
    return {
      _id: l.id as string,
      title: l.title,
      status: l.status,
      branch: b ? { _id: b.id, name: b.name, isHeadOffice: b.isHeadOffice } : null,
      amountKobo: l.amountKobo,
      currency: l.currency,
      lockedOn,
      unlockOn: l.unlockOn,
      unlockAt: l.unlockAt,
      totalDays,
      daysLeft,
      // How far through the lock period it is: 0..10000.
      progressBps: totalDays > 0 ? Math.min(10_000, Math.floor(((totalDays - daysLeft) * 10_000) / totalDays)) : 10_000,
      releasedAt: l.releasedAt ?? null,
      createdBy: u ? { _id: u.id, name: u.name } : null,
      createdAt: l.get("createdAt"),
      // Only the title can change, and only while it's locked.
      canRename: canManage && l.status === "locked",
    };
  });
}

/** Loads a Safelock of this business that the member may see. */
async function findSafelock(req: Request, id: string) {
  if (!isValidObjectId(id)) throw new HttpError(400, "Invalid id");
  await releaseDueSafelocks({ _id: new Types.ObjectId(id) });
  const lock = await SafelockModel.findOne({ _id: id, business: req.business!._id });
  if (!lock || !canAccessBranch(req.membership!, lock.branch)) throw new HttpError(404, "Safelock not found", "SAFELOCK_NOT_FOUND");
  return lock;
}

// ---------------------------------------------------------------------------------------------------------

/** What a new lock may be, for the create form. */
export const getSafelockLimits: RequestHandler = async (_req, res) => {
  const { earliest, latest } = unlockWindow();
  res.json({
    minAmountKobo: SAFELOCK_MIN_AMOUNT_KOBO,
    maxAmountKobo: SAFELOCK_MAX_AMOUNT_KOBO,
    minDays: SAFELOCK_MIN_DAYS,
    maxDays: SAFELOCK_MAX_DAYS,
    earliestUnlockOn: earliest,
    latestUnlockOn: latest,
    maxPerBranch: SAFELOCK_MAX_PER_BRANCH,
    canBreakEarly: false,
    interestRateBps: 0,
  });
};

/** Safelocks on the member's branches. Running ones first (soonest to unlock), then released, newest first. */
export const listSafelocks: RequestHandler = async (req, res) => {
  const query = z
    .object({ branch: objectId.optional(), status: z.enum([...SAFELOCK_STATUSES, "all"]).default("locked") })
    .parse(req.query);
  if (query.branch && !canAccessBranch(req.membership!, query.branch)) throw new HttpError(404, "Branch not found");
  await releaseDueSafelocks({ business: req.business!._id });
  const scope = branchScope(req.membership!);
  const filter = {
    business: req.business!._id,
    ...(query.branch ? { branch: new Types.ObjectId(query.branch) } : scope ? { branch: { $in: scope } } : {}),
    ...(query.status !== "all" && { status: query.status }),
  };
  const locks = await SafelockModel.find(filter);
  locks.sort((a, b) =>
    a.status !== b.status
      ? a.status === "locked" ? -1 : 1
      : a.status === "locked"
        ? a.unlockAt.getTime() - b.unlockAt.getTime()
        : (b.releasedAt?.getTime() ?? 0) - (a.releasedAt?.getTime() ?? 0),
  );
  const lockedKobo = locks.filter((l) => l.status === "locked").reduce((s, l) => s + l.amountKobo, 0);
  res.json({ items: await serialize(req, locks), lockedKobo, currency: "NGN" });
};

export const getSafelock: RequestHandler<IdParams> = async (req, res) => {
  res.json((await serialize(req, [await findSafelock(req, req.params.id)]))[0]);
};

/** Locks money from a branch's available balance until `unlockOn`. Send an Idempotency-Key header to retry safely. */
export const createSafelockHandler: RequestHandler = async (req, res) => {
  const body = z
    .object({
      branch: objectId,
      title,
      amountKobo: z.number().int().min(100).max(SAFELOCK_MAX_AMOUNT_KOBO),
      unlockOn: day,
    })
    .parse(req.body);
  const { safelock, replayed } = await createSafelock({
    business: req.business!,
    membership: req.membership!,
    userId: req.userId!,
    branchId: body.branch,
    title: body.title,
    amountKobo: body.amountKobo,
    unlockOn: body.unlockOn,
    clientKey: clientKey(req),
  });
  res.status(replayed ? 200 : 201).json((await serialize(req, [safelock]))[0]);
};

/** Renames a running Safelock. Nothing else about it can change. */
export const updateSafelock: RequestHandler<IdParams> = async (req, res) => {
  const body = z.object({ title }).strict().parse(req.body);
  const lock = await findSafelock(req, req.params.id);
  if (lock.status !== "locked") throw new HttpError(409, "This Safelock has already been released", "SAFELOCK_RELEASED");
  lock.title = body.title;
  await lock.save();
  res.json((await serialize(req, [lock]))[0]);
};
