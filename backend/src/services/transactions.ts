import { TransactionModel, type TransactionStatus } from "../models/Transaction";
import { VirtualAccountModel } from "../models/VirtualAccount";
import { liquifia, type LiquifiaInboundTransfer } from "./liquifia/client";

const PAGE_SIZE = 100;
// Safety cap per run. The API's sort order isn't documented, so each run reads every page up to this.
const MAX_PAGES = 50;

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
  const result = await TransactionModel.updateOne(
    { providerTransactionId: transfer.id },
    {
      $set: {
        status: mapStatus(transfer.latest_status),
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
    { upsert: true },
  );
  return result.upsertedCount > 0 ? ("created" as const) : ("updated" as const);
}

/** Pulls incoming transfers from Liquifia and records any new ones or status changes. Safe to run repeatedly. */
export async function syncInboundTransfers() {
  const accounts = new Map(
    (await VirtualAccountModel.find().select("providerAccountId business branch")).map((a) => [a.providerAccountId, a]),
  );
  const counts = { created: 0, updated: 0, skipped: 0, failed: 0, pages: 0 };

  for (let page = 0; page < MAX_PAGES; page++) {
    const transfers = await liquifia.listInboundTransfers({ skip: page * PAGE_SIZE, take: PAGE_SIZE });
    counts.pages++;
    for (const transfer of transfers) {
      try {
        counts[await upsertInboundTransfer(transfer, accounts)]++;
      } catch (err) {
        counts.failed++;
        console.error(`Couldn't record inbound transfer ${transfer.id}:`, err);
      }
    }
    if (transfers.length < PAGE_SIZE) return counts;
  }
  console.warn(`Inbound transfer sync stopped after ${MAX_PAGES} pages; add an incremental cursor.`);
  return counts;
}

let running: Promise<unknown> | null = null;
let lastSyncAt = 0;

/** Runs a sync unless one ran in the last `maxAgeMs`. Concurrent callers share the same run. */
export function syncIfStale(maxAgeMs: number) {
  if (running) return running;
  if (Date.now() - lastSyncAt < maxAgeMs) return Promise.resolve();
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

/** Starts the background sync (not used in tests). */
export function startTransactionSync(intervalMs: number) {
  if (intervalMs <= 0) return () => {};
  const tick = () => syncIfStale(0).catch((err) => console.error("Inbound transfer sync failed:", err));
  tick();
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
}

/** Test helper: forget the last sync time. */
export function resetSyncState() {
  lastSyncAt = 0;
}
