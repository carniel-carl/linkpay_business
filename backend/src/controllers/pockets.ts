import type { Request, RequestHandler } from "express";
import { isValidObjectId, Types } from "mongoose";
import { z } from "zod";
import { BranchModel } from "../models/Branch";
import { POCKET_COLORS, POCKET_ICONS, POCKET_STATUSES, PocketModel, PocketMovementModel, type PocketDocument, type PocketMovementDocument } from "../models/Pocket";
import { UserModel } from "../models/User";
import {
  assertNameFree,
  assertRoomForPocket,
  branchAccount,
  closePocket,
  movePocketMoney,
  refreshTarget,
  savePocket,
  settlePocketMovements,
  STALE_MOVEMENT_MS,
  todayInLagos,
} from "../services/pockets";
import { branchScope, canAccessBranch, hasPermission } from "../services/team";
import { HttpError } from "../utils/HttpError";

type IdParams = { id: string };

const objectId = z.string().refine(isValidObjectId, "Invalid id");
// ₦1 to ₦100m per move; the available balance is the real limit.
const amountKobo = z.number().int().min(100, "The smallest amount is ₦1").max(100_000_000_00);
const name = z.string().trim().min(1, "Give the pocket a name").max(40);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const target = z.object({ amountKobo, date: day.nullable().optional() });
const autoSave = z.union([
  z.object({ percentBps: z.number().int().min(100, "At least 1%").max(10_000) }).strict(),
  z.object({ amountKobo }).strict(),
]);

function clientKey(req: Request) {
  const key = req.header("idempotency-key")?.trim();
  if (key && !/^[A-Za-z0-9_-]{8,100}$/.test(key)) throw new HttpError(400, "Invalid Idempotency-Key header");
  return key || undefined;
}

function checkTargetDate(date: string | null | undefined) {
  if (date && date <= todayInLagos()) throw new HttpError(400, "The target date must be in the future", "INVALID_DATES");
}

// ---------------------------------------------------------------------------------------------------------

async function serialize(req: Request, pockets: PocketDocument[]) {
  const [users, branches] = await Promise.all([
    UserModel.find({ _id: { $in: pockets.map((p) => p.createdBy) } }).select("name"),
    BranchModel.find({ _id: { $in: pockets.map((p) => p.branch) } }).select("name isHeadOffice"),
  ]);
  const canManage = hasPermission(req.membership!, "savings.manage");
  return pockets.map((p) => {
    const u = users.find((x) => x._id.equals(p.createdBy));
    const b = branches.find((x) => x._id.equals(p.branch));
    const targetKobo = p.target?.amountKobo ?? null;
    return {
      _id: p.id as string,
      name: p.name,
      icon: p.icon ?? null,
      color: p.color,
      status: p.status,
      branch: b ? { _id: b.id, name: b.name, isHeadOffice: b.isHeadOffice } : null,
      balanceKobo: p.balanceKobo,
      currency: "NGN",
      target: targetKobo
        ? {
            amountKobo: targetKobo,
            date: p.target?.date ?? null,
            reachedAt: p.target?.reachedAt ?? null,
            // 0..10000 (10000 = 100%); capped, so an over-filled pocket shows as full.
            progressBps: Math.min(10_000, Math.floor((p.balanceKobo * 10_000) / targetKobo)),
            remainingKobo: Math.max(0, targetKobo - p.balanceKobo),
          }
        : null,
      autoSave: p.autoSave?.since
        ? p.autoSave.percentBps
          ? { percentBps: p.autoSave.percentBps, amountKobo: null, since: p.autoSave.since }
          : { percentBps: null, amountKobo: p.autoSave.amountKobo!, since: p.autoSave.since }
        : null,
      createdBy: u ? { _id: u.id, name: u.name } : null,
      createdAt: p.get("createdAt"),
      closedAt: p.closedAt ?? null,
      canManage: canManage && p.status === "active",
    };
  });
}

async function serializeMovements(movements: PocketMovementDocument[]) {
  const users = await UserModel.find({ _id: { $in: movements.map((m) => m.createdBy).filter(Boolean) } }).select("name");
  return movements.map((m) => {
    const u = m.createdBy && users.find((x) => x._id.equals(m.createdBy!));
    return {
      _id: m.id as string,
      kind: m.kind,
      direction: m.direction,
      amountKobo: m.amountKobo,
      balanceAfterKobo: m.balanceAfterKobo,
      note: m.note ?? null,
      transaction: m.transaction ? String(m.transaction) : null,
      createdBy: u ? { _id: u.id, name: u.name } : null,
      createdAt: m.get("createdAt"),
    };
  });
}

/** Loads a pocket of this business that the member may see. */
async function findPocket(req: Request, id: string) {
  if (!isValidObjectId(id)) throw new HttpError(400, "Invalid id");
  const pocket = await PocketModel.findOne({ _id: id, business: req.business!._id });
  if (!pocket || !canAccessBranch(req.membership!, pocket.branch)) throw new HttpError(404, "Pocket not found", "POCKET_NOT_FOUND");
  return pocket;
}

// ---------------------------------------------------------------------------------------------------------

/** Pockets on the member's branches, with the total saved. Open ones first, oldest first. */
export const listPockets: RequestHandler = async (req, res) => {
  const query = z
    .object({ branch: objectId.optional(), status: z.enum([...POCKET_STATUSES, "all"]).default("active") })
    .parse(req.query);
  if (query.branch && !canAccessBranch(req.membership!, query.branch)) throw new HttpError(404, "Branch not found");
  const scope = branchScope(req.membership!);
  const filter = {
    business: req.business!._id,
    ...(query.branch ? { branch: new Types.ObjectId(query.branch) } : scope ? { branch: { $in: scope } } : {}),
    ...(query.status !== "all" && { status: query.status }),
  };
  const pockets = await PocketModel.find(filter).sort({ status: 1, createdAt: 1 });
  const savedKobo = pockets.filter((p) => p.status === "active").reduce((s, p) => s + p.balanceKobo, 0);
  res.json({ items: await serialize(req, pockets), savedKobo, currency: "NGN" });
};

export const getPocket: RequestHandler<IdParams> = async (req, res) => {
  res.json((await serialize(req, [await findPocket(req, req.params.id)]))[0]);
};

export const createPocket: RequestHandler = async (req, res) => {
  const body = z
    .object({
      branch: objectId,
      name,
      icon: z.enum(POCKET_ICONS).optional(),
      color: z.enum(POCKET_COLORS).optional(),
      target: target.optional(),
      autoSave: autoSave.optional(),
    })
    .parse(req.body);
  checkTargetDate(body.target?.date);
  const { branch, account } = await branchAccount(req.business!, req.membership!, body.branch);
  await assertRoomForPocket(branch._id);
  await assertNameFree(branch._id, body.name);

  const pocket = new PocketModel({
    business: req.business!._id,
    branch: branch._id,
    virtualAccount: account._id,
    name: body.name,
    icon: body.icon,
    color: body.color,
    target: body.target ? { amountKobo: body.target.amountKobo, date: body.target.date ?? undefined } : undefined,
    autoSave: body.autoSave ? { ...body.autoSave, since: new Date() } : undefined,
    createdBy: req.userId,
  });
  await savePocket(pocket);
  res.status(201).json((await serialize(req, [pocket]))[0]);
};

/** Edits the name, look, target or auto-save rule. `null` removes the target, icon or rule. */
export const updatePocket: RequestHandler<IdParams> = async (req, res) => {
  const body = z
    .object({
      name: name.optional(),
      icon: z.enum(POCKET_ICONS).nullable().optional(),
      color: z.enum(POCKET_COLORS).optional(),
      target: target.nullable().optional(),
      autoSave: autoSave.nullable().optional(),
    })
    .strict()
    .parse(req.body);
  const pocket = await findPocket(req, req.params.id);
  if (pocket.status !== "active") throw new HttpError(409, "This pocket is closed", "POCKET_CLOSED");

  if (body.name !== undefined && body.name !== pocket.name) {
    await assertNameFree(pocket.branch, body.name, pocket._id);
    pocket.name = body.name;
  }
  if (body.icon !== undefined) pocket.set("icon", body.icon ?? undefined);
  if (body.color) pocket.color = body.color;
  if (body.target !== undefined) {
    if (body.target === null) pocket.set("target", undefined);
    else {
      // A new date must be in the future; an unchanged one may have passed.
      if (body.target.date !== pocket.target?.date) checkTargetDate(body.target.date);
      const sameAmount = body.target.amountKobo === pocket.target?.amountKobo;
      pocket.set("target", {
        amountKobo: body.target.amountKobo,
        date: body.target.date === undefined ? pocket.target?.date : (body.target.date ?? undefined),
        // A new amount gets its own "reached" moment (and notification).
        reachedAt: sameAmount ? pocket.target?.reachedAt : undefined,
      });
    }
  }
  if (body.autoSave !== undefined) {
    if (body.autoSave === null) pocket.set("autoSave", undefined);
    else {
      // Keep the start time when the rule is unchanged, so payments already seen aren't saved again.
      const same =
        pocket.autoSave?.since &&
        (pocket.autoSave.percentBps ?? null) === ("percentBps" in body.autoSave ? body.autoSave.percentBps : null) &&
        (pocket.autoSave.amountKobo ?? null) === ("amountKobo" in body.autoSave ? body.autoSave.amountKobo : null);
      if (!same) pocket.set("autoSave", { ...body.autoSave, since: new Date() });
    }
  }
  await savePocket(pocket);
  await refreshTarget(pocket);
  res.json((await serialize(req, [pocket]))[0]);
};

const moveBody = z.object({ amountKobo, note: z.string().trim().max(100).optional() });

/** Sets money aside: from the branch's available balance into the pocket. */
export const depositToPocket: RequestHandler<IdParams> = async (req, res) => {
  const body = moveBody.parse(req.body);
  const pocket = await findPocket(req, req.params.id);
  // A closed pocket is refused by movePocketMoney, after a retry of this Idempotency-Key is answered.
  const { movement, replayed } = await movePocketMoney({
    pocket,
    kind: "deposit",
    amountKobo: body.amountKobo,
    note: body.note,
    userId: req.userId,
    clientKey: clientKey(req),
  });
  const fresh = (await PocketModel.findById(pocket._id))!;
  res.status(replayed ? 200 : 201).json({ pocket: (await serialize(req, [fresh]))[0], movement: (await serializeMovements([movement]))[0] });
};

/** Moves money back from the pocket to the branch's available balance. */
export const withdrawFromPocket: RequestHandler<IdParams> = async (req, res) => {
  const body = moveBody.parse(req.body);
  const pocket = await findPocket(req, req.params.id);
  // A closed pocket is refused by movePocketMoney, after a retry of this Idempotency-Key is answered.
  const { movement, replayed } = await movePocketMoney({
    pocket,
    kind: "withdrawal",
    amountKobo: body.amountKobo,
    note: body.note,
    userId: req.userId,
    clientKey: clientKey(req),
  });
  const fresh = (await PocketModel.findById(pocket._id))!;
  res.status(replayed ? 200 : 201).json({ pocket: (await serialize(req, [fresh]))[0], movement: (await serializeMovements([movement]))[0] });
};

/** Returns whatever is left to the available balance and closes the pocket. */
export const closePocketHandler: RequestHandler<IdParams> = async (req, res) => {
  const pocket = await findPocket(req, req.params.id);
  const closed = await closePocket(pocket, req.userId!);
  res.json((await serialize(req, [closed]))[0]);
};

/** The pocket's movements, newest first. Next page: `before=<nextBefore>`. */
export const listPocketActivity: RequestHandler<IdParams> = async (req, res) => {
  const query = z.object({ before: objectId.optional(), take: z.coerce.number().int().min(1).max(100).default(20) }).parse(req.query);
  const pocket = await findPocket(req, req.params.id);
  // A movement a crash left half-done shows once settled; a recent pending one is a move still in progress.
  await settlePocketMovements(pocket._id, { olderThanMs: STALE_MOVEMENT_MS });
  const movements = await PocketMovementModel.find({
    pocket: pocket._id,
    state: { $ne: "pending" },
    ...(query.before && { _id: { $lt: new Types.ObjectId(query.before) } }),
  })
    .sort({ _id: -1 })
    .limit(query.take + 1);
  const page = movements.slice(0, query.take);
  res.json({ items: await serializeMovements(page), nextBefore: movements.length > query.take ? page.at(-1)!.id : null });
};
