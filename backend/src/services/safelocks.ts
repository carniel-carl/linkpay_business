import {
  SAFELOCK_MAX_DAYS,
  SAFELOCK_MAX_PER_BRANCH,
  SAFELOCK_MIN_AMOUNT_KOBO,
  SAFELOCK_MIN_DAYS,
} from "../config/safelock";
import type { Types } from "mongoose";
import { BranchModel } from "../models/Branch";
import { BusinessModel, type BusinessDocument } from "../models/Business";
import type { MembershipDocument } from "../models/Membership";
import { SafelockModel } from "../models/Safelock";
import { HttpError } from "../utils/HttpError";
import { assertSameRequest, isDuplicateClientKey, requestHash } from "../utils/idempotency";
import { safelockReleased } from "./notificationEvents";
import { branchAccount, todayInLagos } from "./pockets";
import { availableBalance, withAccountLock } from "./transfers";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Midnight at the start of a Lagos day (Lagos is UTC+1 all year). */
export const startOfLagosDay = (day: string) => new Date(`${day}T00:00:00+01:00`);

/** Whole days from one YYYY-MM-DD to another. */
export const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

export function addDays(day: string, days: number) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The earliest and latest unlock days a lock made today can have. */
export function unlockWindow(today = todayInLagos()) {
  return { earliest: addDays(today, SAFELOCK_MIN_DAYS), latest: addDays(today, SAFELOCK_MAX_DAYS) };
}

/**
 * Locks `amountKobo` of a branch's available balance until `unlockOn`. Runs under the account's lock, so a
 * transfer or pocket can't spend the same money at the same moment. Can't be undone.
 */
export async function createSafelock(opts: {
  business: BusinessDocument;
  membership: MembershipDocument;
  userId: string;
  branchId: string;
  title: string;
  amountKobo: number;
  unlockOn: string;
  clientKey?: string;
}) {
  const { business, userId, amountKobo, unlockOn } = opts;
  if (amountKobo < SAFELOCK_MIN_AMOUNT_KOBO) {
    throw new HttpError(400, `The smallest Safelock is ₦${(SAFELOCK_MIN_AMOUNT_KOBO / 100).toLocaleString("en-NG")}`, "SAFELOCK_TOO_SMALL", {
      minAmountKobo: SAFELOCK_MIN_AMOUNT_KOBO,
    });
  }
  const { earliest, latest } = unlockWindow();
  if (unlockOn < earliest || unlockOn > latest) {
    throw new HttpError(400, `Choose an unlock date ${SAFELOCK_MIN_DAYS} to ${SAFELOCK_MAX_DAYS} days from today`, "INVALID_UNLOCK_DATE", {
      earliest,
      latest,
    });
  }
  const { branch, account } = await branchAccount(business, opts.membership, opts.branchId);
  // What this request asks for, so the same Idempotency-Key with different details is refused.
  const hash = opts.clientKey ? requestHash({ branch: String(branch._id), title: opts.title, amountKobo, unlockOn }) : undefined;

  /** The Safelock first created with this Idempotency-Key, if it was used before. */
  const replay = async () => {
    if (!opts.clientKey) return null;
    const first = await SafelockModel.findOne({ business: business._id, createdBy: userId, clientKey: opts.clientKey });
    if (!first) return null;
    assertSameRequest(first.requestHash, hash);
    return { safelock: first, replayed: true };
  };

  return withAccountLock(account._id, async (lock) => {
    const replayed = await replay();
    if (replayed) return replayed;
    const running = await SafelockModel.countDocuments({ branch: branch._id, status: "locked" });
    if (running >= SAFELOCK_MAX_PER_BRANCH) {
      throw new HttpError(409, `A branch can have up to ${SAFELOCK_MAX_PER_BRANCH} Safelocks running at once.`, "SAFELOCK_LIMIT");
    }
    const { availableKobo } = await availableBalance(account);
    if (amountKobo > availableKobo) {
      throw new HttpError(422, "There isn't enough available money in this account", "INSUFFICIENT_BALANCE", {
        availableKobo: Math.max(0, availableKobo),
        requiredKobo: amountKobo,
      });
    }
    await lock.confirm();
    try {
      const safelock = await SafelockModel.create({
        business: business._id,
        branch: branch._id,
        virtualAccount: account._id,
        title: opts.title,
        amountKobo,
        unlockOn,
        unlockAt: startOfLagosDay(unlockOn),
        createdBy: userId,
        clientKey: opts.clientKey,
        requestHash: hash,
      });
      return { safelock, replayed: false };
    } catch (err) {
      // A request with the same key got in first (e.g. from another branch's account): answer as its replay.
      const replayed = isDuplicateClientKey(err) ? await replay() : null;
      if (replayed) return replayed;
      throw err;
    }
  });
}

/**
 * Marks locks whose unlock time has passed as released and tells the branch's team. The money already
 * counts as available from `unlockAt` (see savings.ts); this records it. Safe to run repeatedly.
 */
export async function releaseDueSafelocks(filter: { business?: Types.ObjectId; _id?: Types.ObjectId } = {}, now = new Date()) {
  const due = await SafelockModel.find({ ...filter, status: "locked", unlockAt: { $lte: now } }).limit(500);
  let released = 0;
  for (const lock of due) {
    // Claim it first, so two runs can't both notify.
    const claimed = await SafelockModel.findOneAndUpdate(
      { _id: lock._id, status: "locked" },
      { status: "released", releasedAt: now },
      { returnDocument: "after" },
    );
    if (!claimed) continue;
    released++;
    try {
      const [business, branch] = await Promise.all([
        BusinessModel.findById(claimed.business).select("name owner"),
        BranchModel.findById(claimed.branch).select("name"),
      ]);
      if (business) await safelockReleased(business, claimed, branch?.name ?? "the branch");
    } catch (err) {
      console.error(`Couldn't tell the team Safelock ${claimed.id} was released:`, err);
    }
  }
  return { released };
}

let running: Promise<unknown> | null = null;

/** Releases due Safelocks in the background (not used in tests). */
export function startSafelockReleases(intervalMs: number) {
  if (intervalMs <= 0) return () => {};
  const tick = () => {
    if (running) return;
    running = releaseDueSafelocks()
      .catch((err) => console.error("Safelock release failed:", err))
      .finally(() => {
        running = null;
      });
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
}
