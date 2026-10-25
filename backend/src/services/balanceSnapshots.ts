import { BalanceSnapshotModel } from "../models/BalanceSnapshot";
import { VirtualAccountModel } from "../models/VirtualAccount";
import { inPool } from "../utils/pool";
import { liquifia } from "./liquifia/client";

// Each account's balance at the start of every Lagos day, as Liquifia reports it, so statements can show opening
// and closing balances the bank itself gave (docs/briefs/statements.md). Liquifia only reports the current balance,
// so a day missed is gone: nothing is ever worked out backwards or filled in.

/** Changed only by tests. */
export const BALANCE_SNAPSHOTS = {
  /**
   * How long after 00:00 WAT a snapshot still stands for that day's opening balance. The job looks every minute,
   * so a snapshot normally lands a minute or two after midnight; 15 minutes leaves room for about a dozen retries
   * of an account whose first lookup failed, while keeping "at the start of the day" true to within a quarter of an
   * hour. Transactions in that gap are named by the statement's reconciliation, not hidden.
   */
  toleranceMs: 15 * 60_000,
  /** Liquifia balance lookups at once. */
  concurrency: 5,
  /** Each lookup's timeout. */
  timeoutMs: 10_000,
  /** The job looks for missing snapshots this often (or with the Liquifia sync interval, if that's shorter). */
  checkEveryMs: 60_000,
  /** After the tolerance window, an account whose lookup failed is tried again this long after, not every minute. */
  lateRetryMs: 60 * 60_000,
};

const LAGOS_OFFSET_MS = 60 * 60_000; // UTC+1 all year
/** The Lagos calendar day of an instant, "YYYY-MM-DD". */
export const lagosDayOf = (at: Date) => new Date(at.getTime() + LAGOS_OFFSET_MS).toISOString().slice(0, 10);
/** 00:00 WAT at the start of `day`. */
export const startOfLagosDay = (day: string) => new Date(`${day}T00:00:00+01:00`);

/** Whether a snapshot can stand for its day's opening balance: taken at 00:00 WAT or after, by `toleranceMs`. */
export function snapshotOnTime(snapshot: { day: string; takenAt: Date }) {
  const after = snapshot.takenAt.getTime() - startOfLagosDay(snapshot.day).getTime();
  return after >= 0 && after <= BALANCE_SNAPSHOTS.toleranceMs;
}

export type SnapshotCounts = {
  day: string;
  /** Active accounts, and those still without today's snapshot when the pass began. */
  accounts: number;
  due: number;
  taken: number;
  /** Already recorded by another pass (or instance) by the time this one wrote. */
  existing: number;
  failed: number;
  /** Failed earlier today and waiting for their next try (see `lateRetryMs`). */
  waiting: number;
  /** Asked before midnight and answered after, so it can't be said which day the balance opens: left to the next pass. */
  skipped: number;
};

// Accounts whose lookup failed today, and the earliest time to try each again. In memory: a restart retries at once.
const retryAt = new Map<string, { day: string; at: number }>();

const isDuplicateKey = (err: unknown) => (err as { code?: number })?.code === 11000;

/**
 * One pass: a snapshot for every active account that has none for today (Lagos), each balance read fresh from
 * Liquifia (no cache) with a short timeout, `concurrency` at a time. One account's failure doesn't stop the others;
 * it's tried again on the next pass (once an hour after the tolerance window). Writes insert only, on the unique
 * `{ virtualAccount, day }`, so overlapping passes or instances can't record a day twice or change one. A snapshot
 * taken late keeps its real `takenAt`. `now` is for tests.
 */
export async function takeBalanceSnapshots({ now = () => new Date() }: { now?: () => Date } = {}): Promise<SnapshotCounts> {
  // The writes rely on the unique index: wait for Mongoose's build of it (at once when built). If it failed to
  // build, this throws and nothing is written (GET /health and the startup log say so).
  await BalanceSnapshotModel.init();
  const started = now();
  const day = lagosDayOf(started);
  const inWindow = started.getTime() - startOfLagosDay(day).getTime() <= BALANCE_SNAPSHOTS.toleranceMs;
  for (const [id, r] of retryAt) if (r.day !== day) retryAt.delete(id);

  // Accounts Liquifia opened as active (or that never said); "active" in any case.
  const accounts = await VirtualAccountModel.find({ $or: [{ status: null }, { status: /^active$/i }] })
    .select("business branch providerAccountId")
    .lean();
  const recorded = await BalanceSnapshotModel.find({ virtualAccount: { $in: accounts.map((a) => a._id) }, day })
    .select("virtualAccount")
    .lean();
  const have = new Set(recorded.map((s) => String(s.virtualAccount)));
  const counts: SnapshotCounts = { day, accounts: accounts.length, due: 0, taken: 0, existing: 0, failed: 0, waiting: 0, skipped: 0 };
  const due = accounts.filter((a) => {
    if (have.has(String(a._id))) return false;
    const retry = retryAt.get(String(a._id));
    if (retry && retry.at > started.getTime()) {
      counts.waiting++;
      return false;
    }
    return true;
  });
  counts.due = due.length;

  let firstError: unknown;
  await inPool(due, BALANCE_SNAPSHOTS.concurrency, async (account) => {
    const id = String(account._id);
    try {
      // The day ended while this pass was going: the next pass takes the new day's.
      if (lagosDayOf(now()) !== day) {
        counts.skipped++;
        return;
      }
      const { balance } = await liquifia.getVirtualAccountBalance(account.providerAccountId, { timeoutMs: BALANCE_SNAPSHOTS.timeoutMs });
      const takenAt = now();
      if (lagosDayOf(takenAt) !== day) {
        counts.skipped++;
        return;
      }
      const written = await BalanceSnapshotModel.updateOne(
        { virtualAccount: account._id, day },
        {
          $setOnInsert: {
            business: account.business,
            ...(account.branch && { branch: account.branch }),
            balanceKobo: Math.round(balance),
            takenAt,
          },
        },
        { upsert: true },
      ).catch((err) => {
        // Two writers racing on the same key: the other one's insert stands.
        if (isDuplicateKey(err)) return { upsertedCount: 0 };
        throw err;
      });
      if (written.upsertedCount) counts.taken++;
      else counts.existing++;
      retryAt.delete(id);
    } catch (err) {
      counts.failed++;
      firstError ??= err;
      // In the window the snapshot can still count, so it's tried on every pass; after it, once an hour.
      retryAt.set(id, { day, at: inWindow ? 0 : now().getTime() + BALANCE_SNAPSHOTS.lateRetryMs });
    }
  });
  if (counts.taken || counts.failed) {
    const failed = counts.failed ? `, ${counts.failed} failed (first: ${String(firstError)}); retrying` : "";
    console.log(`Balance snapshots for ${day}: ${counts.taken} taken${failed}`);
  }
  return counts;
}

let running: Promise<SnapshotCounts> | null = null;

/** A pass unless one is already going, in which case that one. */
export function snapshotBalances() {
  running ??= takeBalanceSnapshots().finally(() => {
    running = null;
  });
  return running;
}

/**
 * Looks for missing snapshots every minute (or every `syncIntervalMs`, if shorter), taking each as soon as it can
 * after 00:00 WAT. Off when `syncIntervalMs` is 0 (LIQUIFIA_SYNC_INTERVAL_MS=0), like the other Liquifia jobs.
 */
export function startBalanceSnapshots(syncIntervalMs: number) {
  if (syncIntervalMs <= 0) return () => {};
  const tick = () => {
    if (!running) snapshotBalances().catch((err) => console.error("Balance snapshots failed:", err));
  };
  tick();
  const timer = setInterval(tick, Math.min(syncIntervalMs, BALANCE_SNAPSHOTS.checkEveryMs));
  return () => clearInterval(timer);
}

/** Test helper: forget which accounts are waiting to be retried. */
export function resetBalanceSnapshotRetries() {
  retryAt.clear();
}
