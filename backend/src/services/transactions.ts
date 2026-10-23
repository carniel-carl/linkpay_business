import { BusinessModel } from "../models/Business";
import { SyncStateModel, type ListOrder, type SyncState } from "../models/SyncState";
import { TransactionModel, type TransactionStatus } from "../models/Transaction";
import { VirtualAccountModel } from "../models/VirtualAccount";
import { liquifia, type LiquifiaInboundTransfer } from "./liquifia/client";
import { matchInvoicePayments } from "./invoices";
import { paymentReceived } from "./notificationEvents";
import { matchCheckoutPayments } from "./paymentLinks";
import { applyAutoSaves } from "./pockets";

const PAGE_SIZE = 100;
// Most pages one run reads. Whatever is left carries on in the next run, so a run can't page forever.
const PAGES_PER_RUN = 100;
// Each run reads this far back past what's already recorded, for rows that show up late or out of order.
// Reading a row twice is harmless: it's an upsert on providerTransactionId.
const OVERLAP_MS = 10 * 60_000;
const OVERLAP_ROWS = PAGE_SIZE;
// Our payments still pending, or that couldn't be recorded, are read again on every run until they settle, for a day.
const UNSETTLED_FOR_MS = 24 * 60 * 60_000;
// The list's order is judged from consecutive created_at values: at least this many steps, nearly all one way.
const ORDER_MIN_STEPS = 5;
const ORDER_SHARE = 0.9;
const STATE_KEY = "liquifia.inbound-transfers";

/** Liquifia sends kobo as a string of digits. Anything else is rejected rather than guessed. */
function parseKobo(value: unknown): number {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) throw new Error(`Unexpected amount format: ${JSON.stringify(value)}`);
  return Number(text);
}

function mapStatus(status: string): TransactionStatus {
  switch (status?.toLowerCase()) {
    case "success":
    case "successful":
    case "completed":
      return "success";
    case "failed":
      return "failed";
    case "reversed":
      return "reversed";
    default:
      return "pending";
  }
}

/** Records one inbound transfer. Returns "created", "updated" or "skipped" (not one of our accounts). */
async function upsertInboundTransfer(transfer: LiquifiaInboundTransfer, accounts: Map<string, { _id: any; business: any; branch?: any }>) {
  // The integrator key may also serve accounts that aren't LinkPay Business accounts; ignore those.
  const account = accounts.get(transfer.virtual_account_id);
  if (!account) return "skipped" as const;

  const amountKobo = parseKobo(transfer.amount);
  const feeKobo = parseKobo(transfer.fee ?? "0");
  const status = mapStatus(transfer.latest_status);
  // The document as it was before (null when this is a new payment), to tell when it first succeeds.
  const before = await TransactionModel.findOneAndUpdate(
    { providerTransactionId: transfer.id },
    {
      $set: {
        status,
        feeKobo,
        netKobo: amountKobo - feeKobo,
        providerData: transfer,
      },
      $setOnInsert: {
        business: account.business,
        branch: account.branch,
        virtualAccount: account._id,
        type: "inbound_transfer",
        direction: "credit",
        amountKobo,
        currency: "NGN",
        counterparty: {
          name: transfer.payer_name ?? undefined,
          bankName: transfer.payer_bank_name ?? undefined,
          accountNumber: transfer.payer_bank_account ?? undefined,
        },
        narration: transfer.narration ?? transfer.raw_payload?.narration ?? undefined,
        reference: transfer.reference ?? undefined,
        provider: "liquifia",
        occurredAt: new Date(transfer.created_at),
      },
    },
    { upsert: true, returnDocument: "before", projection: { status: 1 } },
  ).lean();
  if (status === "success" && before?.status !== "success") await notifyPaymentReceived(transfer.id, account.business);
  return before ? ("updated" as const) : ("created" as const);
}

/** Tells the team about money in, once: when the payment is first seen as successful. */
async function notifyPaymentReceived(providerTransactionId: string, businessId: unknown) {
  const [tx, business] = await Promise.all([
    TransactionModel.findOne({ providerTransactionId }).select("branch amountKobo counterparty").lean(),
    BusinessModel.findById(businessId).select("name owner"),
  ]);
  if (tx && business) await paymentReceived(business, tx);
}

/**
 * Pulls incoming transfers from Liquifia and records any new ones or status changes, then links new
 * payments to payment-link checkouts and to the invoices their narration mentions, and applies savings
 * auto-save rules. Safe to run repeatedly. `maxPages` caps how much of the list this run reads.
 */
export async function syncInboundTransfers(opts: { maxPages?: number } = {}) {
  const counts = await pullInboundTransfers(opts.maxPages ?? PAGES_PER_RUN);
  // Before invoices: a transfer that pays a checkout isn't an invoice payment.
  const checkouts = await matchCheckoutPayments().catch((err) => {
    console.error("Matching payments to payment-link checkouts failed:", err);
    return { checked: 0, matched: 0 };
  });
  const invoices = await matchInvoicePayments().catch((err) => {
    console.error("Matching payments to invoices failed:", err);
    return { checked: 0, matched: 0 };
  });
  const autoSaves = await applyAutoSaves().catch((err) => {
    console.error("Applying savings auto-saves failed:", err);
    return { checked: 0, saved: 0 };
  });
  return { ...counts, checkoutsMatched: checkouts.matched, invoicesMatched: invoices.matched, autoSaved: autoSaves.saved };
}

// ---- Reading the list ----
// GET /inbound-transfers lists every payment to every account of the integrator (not only ours), pages by
// skip/take only, and documents no sort order or date filter. So each run tells the order from the rows'
// created_at and reads only what it must:
// - newest first: from the top down to a little before the newest row already recorded;
// - oldest first: from a page before where the last run stopped, if that row is still the one seen there;
// - in no clear order: all of it.
// A run reads at most `maxPages` pages; the rest carries on in the next run, so every row is read in the end.

type Accounts = Map<string, { _id: any; business: any; branch?: any }>;

type Run = {
  accounts: Accounts;
  counts: { created: number; updated: number; skipped: number; failed: number; pages: number };
  pagesLeft: number;
  order: ReturnType<typeof orderTracker>;
  startedAt: number;
};

/** What a run leaves for the next one. Every field is written, so those of another order are cleared. */
type NextState = {
  order: ListOrder | null;
  newestAt: Date | null;
  backlogSkip: number | null;
  backlogUntil: Date | null;
  resumeSkip: number | null;
  resumeId: string | null;
  unsettledAt: Date | null;
  unsettledSkip: number | null;
};

const CLEAR: NextState = {
  order: null,
  newestAt: null,
  backlogSkip: null,
  backlogUntil: null,
  resumeSkip: null,
  resumeId: null,
  unsettledAt: null,
  unsettledSkip: null,
};

// Each of these is logged once per process, not on every run.
const warned = new Set<string>();
function warnOnce(message: string) {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(message);
}

const toDate = (ms: number | undefined) => (ms !== undefined && Number.isFinite(ms) ? new Date(ms) : null);
const msOf = (date: Date | null | undefined) => (date ? date.getTime() : undefined);
function minOf(...values: (number | undefined)[]) {
  const known = values.filter((v): v is number => v !== undefined);
  return known.length ? Math.min(...known) : undefined;
}

/**
 * Tells the list's order from consecutive created_at values. A few steps the other way (rows that arrived late)
 * don't change the verdict. No verdict until there are enough steps to judge.
 */
function orderTracker() {
  let last: number | undefined;
  let up = 0;
  let down = 0;
  return {
    /** The next row isn't next to the last one (another stretch of the list). */
    restart() {
      last = undefined;
    },
    add(at: number) {
      if (Number.isNaN(at)) return;
      if (last !== undefined && at > last) up++;
      if (last !== undefined && at < last) down++;
      last = at;
    },
    verdict(): ListOrder | null {
      const steps = up + down;
      if (steps < ORDER_MIN_STEPS) return null;
      if (down >= steps * ORDER_SHARE) return "newest_first";
      if (up >= steps * ORDER_SHARE) return "oldest_first";
      return "unordered";
    },
  };
}

async function recordRow(row: LiquifiaInboundTransfer, accounts: Accounts) {
  try {
    return await upsertInboundTransfer(row, accounts);
  } catch (err) {
    console.error(`Couldn't record inbound transfer ${row.id}:`, err);
    return "failed" as const;
  }
}

type Segment = {
  /** Position after the last row read. */
  next: number;
  /** Why it stopped: the list ended, it reached its boundary, the run ran out of pages, the list moved, or another order. */
  end: "list" | "boundary" | "budget" | "moved" | "order";
  /** Ids read, by position from where the segment started. */
  ids: string[];
  newestAt?: number;
  /** The oldest time and first position of our payments read here that are still settling. */
  unsettledAt?: number;
  unsettledSkip?: number;
};

/**
 * Reads the list from position `from`, recording every row, until the list or the run's pages run out, or until:
 * a whole page is older than `olderThan`; it reaches position `until`; the first row isn't `expectId` (the list
 * moved since the last run); or the rows so far are in another order than `expectOrder`.
 */
async function readSegment(
  run: Run,
  from: number,
  opts: { olderThan?: number; until?: number; expectId?: string | null; expectOrder?: ListOrder } = {},
): Promise<Segment> {
  const seg: Segment = { next: from, end: "budget", ids: [] };
  const settlingSince = run.startedAt - UNSETTLED_FOR_MS;
  run.order.restart();
  while (run.pagesLeft > 0) {
    run.pagesLeft--;
    run.counts.pages++;
    const rows = await liquifia.listInboundTransfers({ skip: seg.next, take: PAGE_SIZE });
    if (opts.expectId && seg.next === from && rows[0]?.id !== opts.expectId) return { ...seg, end: "moved" };
    for (const [i, row] of rows.entries()) {
      const outcome = await recordRow(row, run.accounts);
      run.counts[outcome]++;
      const at = Date.parse(row.created_at);
      run.order.add(at);
      seg.ids.push(row.id);
      if (at > (seg.newestAt ?? -Infinity)) seg.newestAt = at;
      const settling = outcome === "failed" || (outcome !== "skipped" && mapStatus(row.latest_status) === "pending");
      if (settling && at >= settlingSince) {
        seg.unsettledAt = minOf(seg.unsettledAt, at);
        seg.unsettledSkip ??= seg.next + i;
      }
    }
    seg.next += rows.length;
    const order = run.order.verdict();
    if (opts.expectOrder && order && order !== opts.expectOrder) return { ...seg, end: "order" };
    if (rows.length < PAGE_SIZE) return { ...seg, end: "list" };
    const { olderThan, until } = opts;
    if (olderThan !== undefined && rows.every((r) => Date.parse(r.created_at) < olderThan)) return { ...seg, end: "boundary" };
    if (until !== undefined && seg.next >= until) return { ...seg, end: "boundary" };
  }
  return seg;
}

async function pullInboundTransfers(maxPages: number) {
  const accounts: Accounts = new Map(
    (await VirtualAccountModel.find().select("providerAccountId business branch")).map((a) => [a.providerAccountId, a]),
  );
  const run: Run = {
    accounts,
    counts: { created: 0, updated: 0, skipped: 0, failed: 0, pages: 0 },
    pagesLeft: maxPages,
    order: orderTracker(),
    startedAt: Date.now(),
  };
  const state = await SyncStateModel.findOne({ key: STATE_KEY }).lean();
  const next =
    state?.order === "newest_first"
      ? await readNewestFirst(run, state)
      : state?.order === "oldest_first"
        ? await readOldestFirst(run, state)
        : await readAll(run, state?.resumeSkip ?? 0);
  // Saved only once every row read is recorded, or logged as failed and kept to try again.
  await SyncStateModel.updateOne({ key: STATE_KEY }, { $set: next }, { upsert: true });
  return { ...run.counts, order: next.order };
}

/** The list isn't how the last run left it: read all of it again, from the top. */
function startOver(run: Run, why: string) {
  warnOnce(`Inbound transfer sync: ${why}; reading the whole list again.`);
  return readAll(run, 0);
}

/** Reads the whole list from `from` (a full read carries on where the last run stopped) and plans the next run. */
async function readAll(run: Run, from: number): Promise<NextState> {
  run.order = orderTracker();
  const seg = await readSegment(run, from);
  const order = run.order.verdict();
  // Read in order from the top, so the next run can read less.
  if (from === 0 && order === "newest_first") {
    return newestFirstState(run, seg.newestAt, seg.end === "list" ? null : { skip: seg.next }, seg.unsettledAt);
  }
  if (from === 0 && order === "oldest_first") return oldestFirstState(seg, 0, seg.unsettledSkip);
  if (order === "unordered") warnOnce("Liquifia's inbound-transfer list isn't in date order; reading all of it on every run.");
  return { ...CLEAR, order, resumeSkip: seg.end === "list" ? 0 : seg.next };
}

async function readNewestFirst(run: Run, state: SyncState): Promise<NextState> {
  const settlingSince = run.startedAt - UNSETTLED_FOR_MS;
  const oldUnsettled = msOf(state.unsettledAt);
  const unsettledAt = oldUnsettled !== undefined && oldUnsettled >= settlingSince ? oldUnsettled : undefined;
  const newestAt = msOf(state.newestAt);
  // New rows are at the top: read down to a little before the newest one already recorded, and on to any of
  // our payments still settling.
  const boundary = minOf(newestAt === undefined ? undefined : newestAt - OVERLAP_MS, unsettledAt);
  const head = await readSegment(run, 0, { olderThan: boundary, expectOrder: "newest_first" });
  if (head.end === "order") return startOver(run, "the list is no longer newest first");

  let backlog: { skip: number; until?: number } | null =
    head.end === "list" || state.backlogSkip == null ? null : { skip: state.backlogSkip, until: msOf(state.backlogUntil) };
  let unsettled = head.unsettledAt;
  if (head.end === "budget") {
    // Out of pages before reaching what was already read: the rest waits in the backlog, down to that point.
    backlog = { skip: Math.min(head.next, backlog?.skip ?? Infinity), until: backlog ? backlog.until : boundary };
    unsettled = minOf(unsettled, unsettledAt);
  }
  if (backlog && run.pagesLeft > 0) {
    const deep = await readSegment(run, backlog.skip, { olderThan: backlog.until, expectOrder: "newest_first" });
    if (deep.end === "order") return startOver(run, "the list is no longer newest first");
    backlog = deep.end === "budget" ? { skip: deep.next, until: backlog.until } : null;
    unsettled = minOf(unsettled, deep.unsettledAt);
  }
  return newestFirstState(run, Math.max(newestAt ?? -Infinity, head.newestAt ?? -Infinity), backlog, unsettled);
}

function newestFirstState(run: Run, newestAt: number | undefined, backlog: { skip: number; until?: number } | null, unsettledAt?: number) {
  return {
    ...CLEAR,
    order: "newest_first",
    // Never later than now: a row dated in the future mustn't hide the new ones below it.
    newestAt: toDate(minOf(newestAt, run.startedAt)),
    backlogSkip: backlog?.skip ?? null,
    backlogUntil: toDate(backlog?.until),
    unsettledAt: toDate(unsettledAt),
  } satisfies NextState;
}

async function readOldestFirst(run: Run, state: SyncState): Promise<NextState> {
  const from = state.resumeSkip ?? 0;
  // New rows are at the end: carry on from a page before where the last run stopped, if the list hasn't moved.
  const tail = await readSegment(run, from, { expectId: state.resumeId, expectOrder: "oldest_first" });
  if (tail.end === "moved") return startOver(run, "rows moved in the list since the last run");
  if (tail.end === "order") return startOver(run, "the list is no longer oldest first");

  let unsettledSkip = tail.unsettledSkip;
  if (state.unsettledSkip != null && state.unsettledSkip < from) {
    // Then, with the pages left, our payments still settling further up the list.
    const recheck = await readSegment(run, state.unsettledSkip, { until: from });
    unsettledSkip = minOf(unsettledSkip, recheck.end === "budget" ? (recheck.unsettledSkip ?? recheck.next) : recheck.unsettledSkip);
  }
  return oldestFirstState(tail, from, unsettledSkip);
}

function oldestFirstState(seg: Segment, from: number, unsettledSkip?: number) {
  // A page back from the end of what was read, so rows that land just behind it are read too.
  const resumeSkip = Math.max(from, seg.next - OVERLAP_ROWS);
  return {
    ...CLEAR,
    order: "oldest_first",
    resumeSkip,
    resumeId: resumeSkip > 0 ? (seg.ids[resumeSkip - from] ?? null) : null,
    unsettledSkip: unsettledSkip ?? null,
  } satisfies NextState;
}

// ---- When to sync ----

let running: Promise<unknown> | null = null;
// A run waiting for the current one to finish (see syncAfterNewPayment). Everyone asking meanwhile shares it.
let queued: Promise<unknown> | null = null;
let lastSyncAt = 0;

function startRun() {
  running = syncInboundTransfers()
    .then((counts) => {
      lastSyncAt = Date.now();
      return counts;
    })
    .finally(() => {
      running = null;
    });
  return running;
}

/** Runs a sync unless one ran in the last `maxAgeMs`. Concurrent callers share the same run. */
export function syncIfStale(maxAgeMs: number) {
  if (running) return running;
  if (Date.now() - lastSyncAt < maxAgeMs) return Promise.resolve();
  return startRun();
}

/**
 * For a webhook saying money just arrived: a sync that starts after this call. A run already going may have read
 * past the new payment, so rather than joining it, one more run follows it.
 */
export function syncAfterNewPayment(): Promise<unknown> {
  if (!running) return startRun();
  queued ??= running
    .catch(() => {})
    .then(() => {
      queued = null;
      return running ?? startRun();
    });
  return queued;
}

/** Starts the background sync (not used in tests). */
export function startTransactionSync(intervalMs: number) {
  if (intervalMs <= 0) return () => {};
  const tick = () => syncIfStale(0).catch((err) => console.error("Inbound transfer sync failed:", err));
  tick();
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
}

/** Test helper: forget the last sync time and where the list was read to. */
export async function resetSyncState() {
  lastSyncAt = 0;
  warned.clear();
  await SyncStateModel.deleteMany({});
}
