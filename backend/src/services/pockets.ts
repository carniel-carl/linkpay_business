import type { Types } from "mongoose";
import { BranchModel } from "../models/Branch";
import { BusinessModel, type BusinessDocument } from "../models/Business";
import type { MembershipDocument } from "../models/Membership";
import {
  LEDGER_MEMORY,
  PocketModel,
  PocketMovementModel,
  type PocketDocument,
  type PocketMovementDocument,
  type PocketMovementKind,
} from "../models/Pocket";
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

// Same code and wording as the account lock's (services/transfers.ts): clients already retry it with the same key.
const accountBusy = () => new HttpError(409, "Another payment from this account is in progress. Try again in a moment.", "ACCOUNT_BUSY");

/**
 * Moves money between a pocket and its branch's available balance. Runs under the account's lock, so a
 * transfer can't spend money that's being set aside at the same moment. Returns the movement (and
 * `replayed: true` when the Idempotency-Key was seen before, or the payment was already auto-saved to this pocket).
 *
 * Crash-safe without transactions, in three writes:
 * 1. The movement, `pending`. Its unique indexes (one per Idempotency-Key, one per auto-saved payment) refuse a
 *    duplicate here, before any money moves.
 * 2. The pocket's balance, in one conditional write that also lists the movement in `recentMovements`. It only
 *    lands if the balance is still what step 1 was based on and the movement hasn't been voided.
 * 3. The movement marked `applied`.
 * A crash after 1 or 2 leaves a pending movement; settleMovement() then reads off the pocket whether step 2
 * landed and finishes it, or voids it (so step 2 can never land late) and removes it.
 *
 * A retry with the Idempotency-Key is answered before anything is checked, so it gets its first answer even
 * once the pocket is closed or its balance has moved on; and again under the lock, for two requests at once.
 */
export async function movePocketMoney(move: Move) {
  const { pocket, kind, amountKobo } = move;
  const direction = kind === "deposit" || kind === "auto_save" ? "in" : "out";
  const delta = direction === "in" ? amountKobo : -amountKobo;
  // What this request asks for (the pocket is already part of the key's scope).
  const hash = move.clientKey ? requestHash({ kind, amountKobo, note: move.note ?? null }) : undefined;

  /** The movement already recorded for this Idempotency-Key, or for this payment's auto-save. */
  const replay = async () => {
    const find = async () =>
      (move.clientKey && (await PocketMovementModel.findOne({ pocket: pocket._id, createdBy: move.userId, clientKey: move.clientKey }))) ||
      (move.transactionId && (await PocketMovementModel.findOne({ pocket: pocket._id, transaction: move.transactionId }))) ||
      null;
    let first = await find();
    // Left half-done by a crash (or a holder that lost the lock): only an applied one is a replay.
    if (first?.state === "pending") first = (await settleMovement(first)) === "applied" ? await find() : null;
    if (!first) return null;
    if (move.clientKey) assertSameRequest(first.requestHash, hash);
    return { movement: first, replayed: true };
  };

  // A move this key already made, before the lock and the checks. One a crash left half-done is settled under
  // the lock below, where nothing else can move this pocket's money.
  if (move.clientKey) {
    const first = await PocketMovementModel.findOne({ pocket: pocket._id, createdBy: move.userId, clientKey: move.clientKey });
    if (first?.state === "applied") {
      assertSameRequest(first.requestHash, hash);
      return { movement: first, replayed: true };
    }
  }

  const result = await withAccountLock(pocket.virtualAccount, async (lock) => {
    // Anything an earlier move left half-done on this pocket is settled first, so the checks below see it.
    await settlePocketMovements(pocket._id);
    const replayed = await replay();
    if (replayed) return replayed;
    // A closed pocket is refused before the balance is asked for.
    if ((await PocketModel.findById(pocket._id).select("status"))?.status !== "active") {
      throw new HttpError(409, "This pocket is closed", "POCKET_CLOSED");
    }

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

    const current = await PocketModel.findById(pocket._id);
    const refuse = (now: typeof current): never => {
      if (now?.status !== "active") throw new HttpError(409, "This pocket is closed", "POCKET_CLOSED");
      throw new HttpError(422, "There isn't that much in this pocket", "INSUFFICIENT_POCKET_BALANCE", {
        balanceKobo: now.balanceKobo,
        requiredKobo: amountKobo,
      });
    };
    if (current?.status !== "active" || current.balanceKobo + delta < 0) refuse(current);

    // 1. The ledger line, pending.
    let movement: PocketMovementDocument;
    try {
      movement = await PocketMovementModel.create({
        pocket: pocket._id,
        business: pocket.business,
        kind,
        direction,
        amountKobo,
        balanceAfterKobo: current!.balanceKobo + delta,
        state: "pending",
        note: move.note,
        transaction: move.transactionId,
        createdBy: move.userId,
        clientKey: move.clientKey,
        requestHash: hash,
      });
    } catch (err: any) {
      if (err?.code !== 11000) throw err;
      // The same key or payment got in first: answer as its replay. If that one was half-done and has just been
      // undone, the key is free again for the client's retry.
      const replayed = await replay();
      if (replayed) return replayed;
      throw accountBusy();
    }

    // 2. The balance. Conditional on the balance it was based on, so `balanceAfterKobo` is exact, and on the
    // movement not having been voided by a settle.
    const updated = await PocketModel.findOneAndUpdate(
      {
        _id: pocket._id,
        status: "active",
        balanceKobo: direction === "out" ? { $eq: current!.balanceKobo, $gte: amountKobo } : current!.balanceKobo,
        voidedMovements: { $ne: movement._id },
      },
      { $inc: { balanceKobo: delta }, $push: { recentMovements: { $each: [movement._id], $slice: -LEDGER_MEMORY } } },
      { returnDocument: "after" },
    );
    if (!updated) {
      // Nothing moved and now nothing can (step 2 is a single write that didn't match): drop the line.
      await PocketMovementModel.deleteOne({ _id: movement._id, state: "pending" });
      const now = await PocketModel.findById(pocket._id);
      if (now?.status !== "active" || now.balanceKobo + delta < 0) refuse(now);
      // The balance changed under us, which only happens if our hold on the account ran out.
      throw accountBusy();
    }

    // 3. Done.
    await PocketMovementModel.updateOne({ _id: movement._id, state: "pending" }, { $set: { state: "applied" } });
    movement.state = "applied";
    pocket.balanceKobo = updated.balanceKobo;
    return { movement, replayed: false };
  });

  if (!result.replayed) await updateTarget(pocket);
  return result;
}

// ---------------------------------------------------------------------------------------------------------
// Settling half-done movements (a crash between movePocketMoney's writes)
// ---------------------------------------------------------------------------------------------------------

/** Pending movements older than this are left over from a crash (a live move takes milliseconds). */
export const STALE_MOVEMENT_MS = 60 * 1000;

/**
 * Finishes or undoes one pending movement. One atomic write on the pocket decides: if the pocket doesn't list
 * the movement as landed, it's added to `voidedMovements`, which stops its balance change from ever landing,
 * and the movement is removed (freeing its Idempotency-Key or payment for a retry). Otherwise its balance
 * change landed and it's marked applied. Safe to run alongside the move itself and other settles.
 */
export async function settleMovement(movement: { _id: Types.ObjectId; pocket: Types.ObjectId }): Promise<"applied" | "rolled_back"> {
  const voided = await PocketModel.updateOne(
    { _id: movement.pocket, recentMovements: { $ne: movement._id }, voidedMovements: { $ne: movement._id } },
    { $push: { voidedMovements: { $each: [movement._id], $slice: -LEDGER_MEMORY } } },
  );
  const landed = voided.modifiedCount === 0 && !!(await PocketModel.exists({ _id: movement.pocket, recentMovements: movement._id }));
  if (landed) {
    await PocketMovementModel.updateOne({ _id: movement._id, state: "pending" }, { $set: { state: "applied" } });
    return "applied";
  }
  await PocketMovementModel.deleteOne({ _id: movement._id, state: "pending" });
  return "rolled_back";
}

/**
 * Settles a pocket's pending movements. `olderThanMs` leaves recent ones alone (they may be a move in progress
 * elsewhere); under the account lock every pending one is from a holder that crashed or lost the lock.
 */
export async function settlePocketMovements(pocketId: Types.ObjectId, { olderThanMs = 0 } = {}) {
  const pending = await PocketMovementModel.find({
    pocket: pocketId,
    state: "pending",
    ...(olderThanMs && { createdAt: { $lt: new Date(Date.now() - olderThanMs) } }),
  }).select("pocket");
  for (const m of pending) await settleMovement(m);
  return pending.length;
}

/**
 * Settles every movement left pending for over a minute, on any pocket. Runs with each auto-save pass (after
 * every inbound sync); the pocket's activity list and every move settle their own pocket too.
 */
export async function settleStaleMovements() {
  const pending = await PocketMovementModel.find({ state: "pending", createdAt: { $lt: new Date(Date.now() - STALE_MOVEMENT_MS) } })
    .sort({ createdAt: 1 })
    .limit(500)
    .select("pocket");
  const settled = { applied: 0, rolled_back: 0 };
  for (const m of pending) {
    try {
      settled[await settleMovement(m)]++;
    } catch (err) {
      console.error(`Couldn't settle pocket movement ${m.id} (will try again):`, err);
    }
  }
  return settled;
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
  // Movements a crash left half-done, on any pocket; an unsettled one would hide a missing auto-save below.
  await settleStaleMovements();
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
        // Already saved from this payment on an earlier run (another pocket failed then). A pending one isn't
        // known to have landed: movePocketMoney settles it and saves again or replays.
        if (await PocketMovementModel.exists({ pocket: pocket._id, transaction: tx._id, state: { $ne: "pending" } })) continue;
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
