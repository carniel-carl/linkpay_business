import type { Types } from "mongoose";
import { BranchModel } from "../models/Branch";
import { BusinessModel, type BusinessDocument } from "../models/Business";
import type { MembershipDocument } from "../models/Membership";
import { PocketModel, PocketMovementModel, type PocketDocument, type PocketMovementKind } from "../models/Pocket";
import { TransactionModel } from "../models/Transaction";
import { VirtualAccountModel } from "../models/VirtualAccount";
import { HttpError } from "../utils/HttpError";
import { assertSameRequest, requestHash } from "../utils/idempotency";
import { pocketTargetReached } from "./notificationEvents";
import { canAccessBranch } from "./team";
import { availableBalance, withAccountLock } from "./transfers";

/** Open pockets allowed per branch. */
export const MAX_POCKETS_PER_BRANCH = 20;

const lagosDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos", year: "numeric", month: "2-digit", day: "2-digit" });
export const todayInLagos = (now = new Date()) => lagosDay.format(now);

/** The branch and its account, checking the member can reach it. */
export async function branchAccount(business: BusinessDocument, membership: MembershipDocument, branchId: string) {
  const branch = await BranchModel.findOne({ _id: branchId, business: business._id });
  if (!branch || !canAccessBranch(membership, branch._id)) throw new HttpError(404, "Branch not found");
  const account = await VirtualAccountModel.findOne({ branch: branch._id });
  if (!account) throw new HttpError(409, `${branch.name}'s account isn't ready yet`, "ACCOUNT_NOT_READY");
  return { branch, account };
}

export async function assertNameFree(branchId: Types.ObjectId, name: string, exceptId?: Types.ObjectId) {
  const clash = await PocketModel.findOne({ branch: branchId, status: "active", name, ...(exceptId && { _id: { $ne: exceptId } }) }).collation({
    locale: "en",
    strength: 2,
  });
  if (clash) throw new HttpError(409, "This branch already has a pocket with that name", "POCKET_NAME_TAKEN");
}

/** Saves the pocket, turning a duplicate-name race into the same 409 as the check above. */
export async function savePocket(pocket: PocketDocument) {
  try {
    return await pocket.save();
  } catch (err: any) {
    if (err?.code === 11000) throw new HttpError(409, "This branch already has a pocket with that name", "POCKET_NAME_TAKEN");
    throw err;
  }
}

export async function assertRoomForPocket(branchId: Types.ObjectId) {
  const open = await PocketModel.countDocuments({ branch: branchId, status: "active" });
  if (open >= MAX_POCKETS_PER_BRANCH) {
    throw new HttpError(409, `A branch can have up to ${MAX_POCKETS_PER_BRANCH} pockets. Close one to add another.`, "POCKET_LIMIT");
  }
}

// ---------------------------------------------------------------------------------------------------------
// Moving money
// ---------------------------------------------------------------------------------------------------------

/**
 * Marks the target as reached the first time the balance gets there (and tells the team), or clears the
 * mark when the balance drops below it again.
 */
async function updateTarget(pocket: PocketDocument) {
  const target = pocket.target?.amountKobo;
  if (!target) return;
  if (pocket.balanceKobo >= target && !pocket.target?.reachedAt) {
    const claimed = await PocketModel.findOneAndUpdate(
      { _id: pocket._id, "target.reachedAt": { $exists: false } },
      { "target.reachedAt": new Date() },
      { returnDocument: "after" },
    );
    if (!claimed) return;
    pocket.set("target.reachedAt", claimed.target?.reachedAt);
    const business = await BusinessModel.findById(pocket.business).select("name owner");
    if (business) await pocketTargetReached(business, pocket);
  } else if (pocket.balanceKobo < target && pocket.target?.reachedAt) {
    await PocketModel.updateOne({ _id: pocket._id }, { $unset: { "target.reachedAt": 1 } });
    pocket.set("target.reachedAt", undefined);
  }
}

/** Re-checks the target after it was changed by an edit. */
export async function refreshTarget(pocket: PocketDocument) {
  await updateTarget(pocket);
}

type Move = {
  pocket: PocketDocument;
  kind: PocketMovementKind;
  amountKobo: number;
  note?: string;
  userId?: string;
  clientKey?: string;
  transactionId?: Types.ObjectId;
};

/**
 * Moves money between a pocket and its branch's available balance. Runs under the account's lock, so a
 * transfer can't spend money that's being set aside at the same moment. Returns the movement (and
 * `replayed: true` when the Idempotency-Key was seen before, or the payment was already auto-saved to this pocket).
 */
export async function movePocketMoney(move: Move) {
  const { pocket, kind, amountKobo } = move;
  const direction = kind === "deposit" || kind === "auto_save" ? "in" : "out";
  // What this request asks for (the pocket is already part of the key's scope).
  const hash = move.clientKey ? requestHash({ kind, amountKobo, note: move.note ?? null }) : undefined;

  /** The movement already recorded for this Idempotency-Key, or for this payment's auto-save. */
  const replay = async () => {
    if (move.clientKey) {
      const first = await PocketMovementModel.findOne({ pocket: pocket._id, createdBy: move.userId, clientKey: move.clientKey });
      if (first) {
        assertSameRequest(first.requestHash, hash);
        return { movement: first, replayed: true };
      }
    }
    if (move.transactionId) {
      const saved = await PocketMovementModel.findOne({ pocket: pocket._id, transaction: move.transactionId });
      if (saved) return { movement: saved, replayed: true };
    }
    return null;
  };

  const result = await withAccountLock(pocket.virtualAccount, async (lock) => {
    const replayed = await replay();
    if (replayed) return replayed;

    if (direction === "in") {
      const account = await VirtualAccountModel.findById(pocket.virtualAccount);
      if (!account) throw new HttpError(409, "This branch's account isn't ready yet", "ACCOUNT_NOT_READY");
      const { availableKobo } = await availableBalance(account);
      if (amountKobo > availableKobo) {
        throw new HttpError(422, "There isn't enough available money in this account", "INSUFFICIENT_BALANCE", {
          availableKobo: Math.max(0, availableKobo),
          requiredKobo: amountKobo,
        });
      }
    }
    await lock.confirm();

    const updated = await PocketModel.findOneAndUpdate(
      { _id: pocket._id, status: "active", ...(direction === "out" && { balanceKobo: { $gte: amountKobo } }) },
      { $inc: { balanceKobo: direction === "in" ? amountKobo : -amountKobo } },
      { returnDocument: "after" },
    );
    if (!updated) {
      const current = await PocketModel.findById(pocket._id);
      if (current?.status !== "active") throw new HttpError(409, "This pocket is closed", "POCKET_CLOSED");
      throw new HttpError(422, "There isn't that much in this pocket", "INSUFFICIENT_POCKET_BALANCE", {
        balanceKobo: current.balanceKobo,
        requiredKobo: amountKobo,
      });
    }

    try {
      const movement = await PocketMovementModel.create({
        pocket: pocket._id,
        business: pocket.business,
        kind,
        direction,
        amountKobo,
        balanceAfterKobo: updated.balanceKobo,
        note: move.note,
        transaction: move.transactionId,
        createdBy: move.userId,
        clientKey: move.clientKey,
        requestHash: hash,
      });
      pocket.balanceKobo = updated.balanceKobo;
      return { movement, replayed: false };
    } catch (err: any) {
      // The ledger line couldn't be written (e.g. this payment was already auto-saved): undo the balance.
      await PocketModel.updateOne({ _id: pocket._id }, { $inc: { balanceKobo: direction === "in" ? -amountKobo : amountKobo } });
      // The same key or payment got in first: answer as its replay.
      const replayed = err?.code === 11000 ? await replay() : null;
      if (replayed) return replayed;
      throw err;
    }
  });

  if (!result.replayed) await updateTarget(pocket);
  return result;
}

/** Moves everything left back to the available balance and closes the pocket. */
export async function closePocket(pocket: PocketDocument, userId: string) {
  if (pocket.status !== "active") throw new HttpError(409, "This pocket is already closed", "POCKET_CLOSED");
  const fresh = (await PocketModel.findById(pocket._id))!;
  if (fresh.balanceKobo > 0) {
    await movePocketMoney({ pocket: fresh, kind: "close", amountKobo: fresh.balanceKobo, userId });
  }
  const closed = await PocketModel.findOneAndUpdate(
    { _id: pocket._id, status: "active", balanceKobo: 0 },
    { status: "closed", closedAt: new Date(), closedBy: userId, $unset: { autoSave: 1 } },
    { returnDocument: "after" },
  );
  // Money came in between the two steps (an auto-save): close again from the top.
  if (!closed) return closePocket(fresh, userId);
  return closed;
}

// ---------------------------------------------------------------------------------------------------------
// Auto-save
// ---------------------------------------------------------------------------------------------------------

/** How much of a payment a pocket's rule keeps, before the target and available-balance caps. */
export function autoSaveAmount(rule: { percentBps?: number | null; amountKobo?: number | null }, paymentKobo: number) {
  if (rule.percentBps) return Math.floor((paymentKobo * rule.percentBps) / 10_000);
  if (rule.amountKobo) return Math.min(rule.amountKobo, paymentKobo);
  return 0;
}

/**
 * Applies auto-save rules to incoming payments: each successful payment into an account with auto-saving
 * pockets is marked done (`autoSaveCheckedAt`) once every pocket has saved its share or had nothing to save.
 * If a save fails (the account is busy, the balance check times out), the payment is tried again on the next
 * run; a pocket never saves from the same payment twice (one movement per pocket and payment). Payments
 * between the business's own branches are skipped, and so are payments from before the rule was set. A pocket
 * with a target stops saving once it's reached. Safe to run repeatedly; called after every inbound sync.
 */
export async function applyAutoSaves() {
  const pockets = await PocketModel.find({ status: "active", "autoSave.since": { $exists: true } }).sort({ createdAt: 1 });
  if (!pockets.length) return { checked: 0, saved: 0 };

  const accountIds = [...new Set(pockets.map((p) => String(p.virtualAccount)))];
  const earliest = new Date(Math.min(...pockets.map((p) => p.autoSave!.since!.getTime())));
  const payments = await TransactionModel.find({
    virtualAccount: { $in: accountIds },
    type: "inbound_transfer",
    direction: "credit",
    status: "success",
    occurredAt: { $gte: earliest },
    autoSaveCheckedAt: { $exists: false },
  })
    .sort({ occurredAt: 1 })
    .limit(1000);

  const ownAccounts = new Map<string, Set<string>>();
  async function isOwnBranch(businessId: Types.ObjectId, accountNumber?: string | null) {
    if (!accountNumber) return false;
    const key = String(businessId);
    if (!ownAccounts.has(key)) {
      const accounts = await VirtualAccountModel.find({ business: businessId }).select("accountNumber");
      ownAccounts.set(key, new Set(accounts.map((a) => a.accountNumber)));
    }
    return ownAccounts.get(key)!.has(accountNumber);
  }

  const markChecked = (tx: (typeof payments)[number]) => TransactionModel.updateOne({ _id: tx._id }, { autoSaveCheckedAt: new Date() });

  let saved = 0;
  for (const tx of payments) {
    if (await isOwnBranch(tx.business, tx.counterparty?.accountNumber)) {
      await markChecked(tx);
      continue;
    }

    let failed = false;
    for (const pocket of pockets.filter((p) => p.virtualAccount.equals(tx.virtualAccount) && p.autoSave!.since! <= tx.occurredAt)) {
      try {
        // Already saved from this payment on an earlier run (another pocket failed then).
        if (await PocketMovementModel.exists({ pocket: pocket._id, transaction: tx._id })) continue;
        const fresh = await PocketModel.findOne({ _id: pocket._id, status: "active", "autoSave.since": { $exists: true } });
        if (!fresh) continue;
        let amount = autoSaveAmount(fresh.autoSave!, tx.netKobo);
        const target = fresh.target?.amountKobo;
        if (target) amount = Math.min(amount, target - fresh.balanceKobo);
        const account = await VirtualAccountModel.findById(fresh.virtualAccount);
        if (!account) continue;
        const { availableKobo } = await availableBalance(account);
        amount = Math.min(amount, availableKobo);
        if (amount < 1) continue;
        const { replayed } = await movePocketMoney({ pocket: fresh, kind: "auto_save", amountKobo: amount, transactionId: tx._id });
        if (!replayed) saved++;
      } catch (err) {
        failed = true;
        console.error(`Couldn't auto-save payment ${tx.id} to pocket ${pocket.id} (will try again):`, err);
      }
    }
    // Only once every pocket has its share (or had nothing to save), so a failed save is tried again next run.
    if (!failed) await markChecked(tx);
  }
  return { checked: payments.length, saved };
}
