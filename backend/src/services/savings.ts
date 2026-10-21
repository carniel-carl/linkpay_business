import type { Types } from "mongoose";
import { PocketModel } from "../models/Pocket";
import { SafelockModel } from "../models/Safelock";

/** Money in Safelocks on each account that hasn't reached its unlock time. */
export async function lockedByAccount(accountIds: Types.ObjectId[], now = new Date()) {
  const rows = await SafelockModel.aggregate<{ _id: Types.ObjectId; lockedKobo: number }>([
    { $match: { virtualAccount: { $in: accountIds }, status: "locked", unlockAt: { $gt: now } } },
    { $group: { _id: "$virtualAccount", lockedKobo: { $sum: "$amountKobo" } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.lockedKobo]));
}

/**
 * Money set aside in savings on each account: open pockets plus running Safelocks. It stays in the branch's
 * Liquifia account but isn't available to spend.
 */
export async function savedByAccount(accountIds: Types.ObjectId[]) {
  const [rows, locked] = await Promise.all([
    PocketModel.aggregate<{ _id: Types.ObjectId; savedKobo: number }>([
      { $match: { virtualAccount: { $in: accountIds }, status: "active", balanceKobo: { $gt: 0 } } },
      { $group: { _id: "$virtualAccount", savedKobo: { $sum: "$balanceKobo" } } },
    ]),
    lockedByAccount(accountIds),
  ]);
  const saved = new Map(rows.map((r) => [String(r._id), r.savedKobo]));
  for (const [id, kobo] of locked) saved.set(id, (saved.get(id) ?? 0) + kobo);
  return saved;
}
