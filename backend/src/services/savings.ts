import type { Types } from "mongoose";
import { PocketModel } from "../models/Pocket";

/**
 * Money set aside in savings on each account (open pockets; Safelocks later). It stays in the branch's
 * Liquifia account but isn't available to spend.
 */
export async function savedByAccount(accountIds: Types.ObjectId[]) {
  const rows = await PocketModel.aggregate<{ _id: Types.ObjectId; savedKobo: number }>([
    { $match: { virtualAccount: { $in: accountIds }, status: "active", balanceKobo: { $gt: 0 } } },
    { $group: { _id: "$virtualAccount", savedKobo: { $sum: "$balanceKobo" } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.savedKobo]));
}
