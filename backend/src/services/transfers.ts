import { randomBytes } from "node:crypto";
import type { Types } from "mongoose";
import { BranchModel } from "../models/Branch";
import type { BusinessDocument } from "../models/Business";
import { BusinessModel } from "../models/Business";
import { MembershipModel, type MembershipDocument } from "../models/Membership";
import { TransactionModel } from "../models/Transaction";
import {
  TransferBatchModel,
  TransferModel,
  type TransferDocument,
  type TransferKind,
} from "../models/Transfer";
import { UserModel } from "../models/User";
import { VirtualAccountModel } from "../models/VirtualAccount";
import { HttpError } from "../utils/HttpError";
import { sendTransferAwaitingApprovalEmail, sendTransferFailedEmail, sendTransferRejectedEmail } from "./email";
import { liquifia, LiquifiaError, newIdempotencyKey, toKobo, toNaira, type LiquifiaBank } from "./liquifia/client";
import { canAccessBranch, hasPermission, permissionsFor } from "./team";

// ---------------------------------------------------------------------------------------------------------
// Banks, account lookup and fees
// ---------------------------------------------------------------------------------------------------------

const BANKS_TTL_MS = 24 * 60 * 60 * 1000;
let banksCache: { at: number; banks: LiquifiaBank[] } | null = null;

/** Nigerian banks Liquifia can pay into, sorted by name. Cached for a day (Liquifia caches them too). */
export async function listBanks() {
  if (banksCache && Date.now() - banksCache.at < BANKS_TTL_MS) return banksCache.banks;
  const banks = (await liquifia.listBanks()).sort((a, b) => a.name.localeCompare(b.name));
  banksCache = { at: Date.now(), banks };
  return banks;
}

const normalise = (name: string) =>
  name
    .toLowerCase()
    .replace(/\b(plc|limited|ltd|nigeria|of|bank|microfinance|mfb|the)\b/g, "")
    .replace(/[^a-z0-9]/g, "");

/** Liquifia's id for the bank behind one of our virtual accounts, matched by name and remembered. */
async function bankUuidForAccount(account: { _id: Types.ObjectId; bankUuid?: string | null; bankName?: string | null }) {
  if (account.bankUuid) return account.bankUuid;
  const banks = await listBanks();
  const wanted = account.bankName?.trim().toLowerCase();
  const bank =
    banks.find((b) => b.name.trim().toLowerCase() === wanted) ??
    (wanted ? banks.find((b) => normalise(b.name) && normalise(b.name) === normalise(wanted)) : undefined);
  if (!bank) {
    throw new HttpError(
      409,
      `We can't send to ${account.bankName ?? "this account"}'s bank automatically yet. Contact support.`,
      "RECIPIENT_BANK_UNKNOWN",
    );
  }
  await VirtualAccountModel.updateOne({ _id: account._id }, { bankUuid: bank.uuid });
  return bank.uuid;
}

export type ResolvedRecipient = {
  kind: TransferKind;
  accountNumber: string;
  accountName: string;
  bankName?: string;
  bankUuid: string;
  business?: Types.ObjectId;
  branch?: Types.ObjectId;
  /** Shown to the sender for LinkPay and internal recipients. */
  label?: string;
};

/** Looks the account up with the bank (name enquiry) and notes when it's an account on LinkPay. */
export async function resolveBankRecipient(business: BusinessDocument, accountNumber: string, bankUuid: string): Promise<ResolvedRecipient> {
  const bank = (await listBanks()).find((b) => b.uuid === bankUuid);
  if (!bank) throw new HttpError(400, "Choose a bank from the list", "INVALID_BANK");

  let lookup;
  try {
    lookup = await liquifia.validateAccount(accountNumber, bankUuid);
  } catch (err) {
    if (err instanceof LiquifiaError && err.status >= 400 && err.status < 500) {
      throw new HttpError(422, "We couldn't find that account. Check the number and bank.", "ACCOUNT_NOT_FOUND");
    }
    throw err;
  }
  if (!lookup?.account_name) throw new HttpError(422, "We couldn't find that account. Check the number and bank.", "ACCOUNT_NOT_FOUND");

  const recipient: ResolvedRecipient = {
    kind: "bank",
    accountNumber,
    accountName: lookup.account_name,
    bankName: lookup.bank_name ?? bank.name,
    bankUuid,
  };

  // Is it one of ours? Then it's a branch of this business or another business on LinkPay.
  const ours = await VirtualAccountModel.findOne({ accountNumber }).select("business branch bankUuid bankName");
  if (ours && (!ours.bankUuid || ours.bankUuid === bankUuid)) {
    const branch = ours.branch ? await BranchModel.findById(ours.branch).select("name isHeadOffice") : null;
    if (ours.business.equals(business._id)) {
      Object.assign(recipient, { kind: "internal", business: ours.business, branch: ours.branch, label: branch?.name });
    } else {
      const other = await BusinessModel.findById(ours.business).select("name");
      Object.assign(recipient, { kind: "linkpay", business: ours.business, branch: ours.branch ?? undefined, label: other?.name });
    }
  }
  return recipient;
}

/** One of the business's own branches as the recipient. */
export async function resolveBranchRecipient(business: BusinessDocument, branchId: string): Promise<ResolvedRecipient> {
  const branch = await BranchModel.findOne({ _id: branchId, business: business._id });
  if (!branch) throw new HttpError(404, "Branch not found");
  const account = await VirtualAccountModel.findOne({ branch: branch._id });
  if (!account) throw new HttpError(409, `${branch.name}'s account isn't ready yet`, "ACCOUNT_NOT_READY");
  return {
    kind: "internal",
    accountNumber: account.accountNumber,
    accountName: account.accountName ?? branch.name,
    bankName: account.bankName ?? undefined,
    bankUuid: await bankUuidForAccount(account),
    business: business._id,
    branch: branch._id,
    label: branch.name,
  };
}

const FEE_TTL_MS = 10 * 60 * 1000;
const feeCache = new Map<number, { at: number; feeKobo: number; stampDutyKobo: number }>();

/** Liquifia's fee for a payout of this amount, including the ₦50 stamp duty on ₦10,000 or more. */
export async function quoteFee(amountKobo: number) {
  const cached = feeCache.get(amountKobo);
  if (cached && Date.now() - cached.at < FEE_TTL_MS) return { feeKobo: cached.feeKobo, stampDutyKobo: cached.stampDutyKobo };
  const quote = await liquifia.quotePayoutFee(toNaira(amountKobo));
  const result = { feeKobo: toKobo(quote.fee), stampDutyKobo: toKobo(quote.stamp_duty ?? 0) };
  feeCache.set(amountKobo, { at: Date.now(), ...result });
  return result;
}

// ---------------------------------------------------------------------------------------------------------
// Balances and holds
// ---------------------------------------------------------------------------------------------------------

/**
 * What our side still holds on each account: transfers waiting for approval, and approved ones that
 * Liquifia hasn't accepted yet. Once Liquifia accepts a payout it debits the account itself.
 */
export async function heldByAccount(accountIds: Types.ObjectId[]) {
  const rows = await TransferModel.aggregate<{ _id: Types.ObjectId; heldKobo: number }>([
    {
      $match: {
        virtualAccount: { $in: accountIds },
        $or: [{ status: "pending_approval" }, { status: "processing", "provider.payoutId": { $exists: false } }],
      },
    },
    { $group: { _id: "$virtualAccount", heldKobo: { $sum: "$totalKobo" } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.heldKobo]));
}

export async function availableBalance(account: { _id: Types.ObjectId; providerAccountId: string }) {
  const [balance, held] = await Promise.all([
    liquifia.getVirtualAccountBalance(account.providerAccountId),
    heldByAccount([account._id]),
  ]);
  const balanceKobo = Math.round(balance.balance);
  const heldKobo = held.get(String(account._id)) ?? 0;
  return { balanceKobo, heldKobo, availableKobo: balanceKobo - heldKobo };
}

const LOCK_MS = 15_000;

/** Runs `fn` while holding a short lock on the account, so two transfers can't spend the same money. */
async function withAccountLock<T>(accountId: Types.ObjectId, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const now = new Date();
    const locked = await VirtualAccountModel.findOneAndUpdate(
      { _id: accountId, $or: [{ lockedUntil: { $exists: false } }, { lockedUntil: null }, { lockedUntil: { $lt: now } }] },
      { lockedUntil: new Date(now.getTime() + LOCK_MS) },
    );
    if (locked) {
      try {
        return await fn();
      } finally {
        await VirtualAccountModel.updateOne({ _id: accountId }, { $unset: { lockedUntil: 1 } });
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new HttpError(409, "Another transfer from this account is in progress. Try again in a moment.", "ACCOUNT_BUSY");
}

// ---------------------------------------------------------------------------------------------------------
// Creating transfers
// ---------------------------------------------------------------------------------------------------------

export type TransferRequest = { recipient: ResolvedRecipient; amountKobo: number; narration?: string };

const newReference = () => `LPB${randomBytes(8).toString("hex").toUpperCase()}`;

/** Does this transfer need someone else to approve it before it goes? */
export function needsApproval(business: BusinessDocument, membership: MembershipDocument, totalAmountKobo: number) {
  if (!hasPermission(membership, "transfers.approve")) return true;
  const rule = business.transferApproval;
  if (rule?.mode === "always") return true;
  if (rule?.mode === "above_threshold" && totalAmountKobo >= (rule.thresholdKobo ?? 0)) return true;
  return false;
}

/** Team members (other than `exceptUserId`) who can approve transfers from this branch. */
export async function eligibleApprovers(business: BusinessDocument, branchId: Types.ObjectId, exceptUserId: string) {
  const memberships = await MembershipModel.find({ business: business._id, user: { $ne: exceptUserId } });
  const approvers = memberships.filter((m) => permissionsFor(m.role).includes("transfers.approve") && canAccessBranch(m, branchId));
  // The owner's membership is created lazily, so count the owner even without one.
  if (!business.owner.equals(exceptUserId) && !approvers.some((m) => m.user.equals(business.owner))) {
    return [business.owner, ...approvers.map((m) => m.user)];
  }
  return approvers.map((m) => m.user);
}

/**
 * Creates one transfer, or a batch, from a branch's account. Checks the available balance and holds the
 * money under a lock. Transfers that don't need approval are sent to Liquifia straight away.
 */
export async function createTransfers(opts: {
  business: BusinessDocument;
  membership: MembershipDocument;
  userId: string;
  branchId: string;
  requests: TransferRequest[];
  batchTitle?: string;
  clientKey?: string;
}) {
  const { business, membership, userId, requests } = opts;
  const branch = await BranchModel.findOne({ _id: opts.branchId, business: business._id });
  if (!branch || !canAccessBranch(membership, branch._id)) throw new HttpError(404, "Branch not found");
  const account = await VirtualAccountModel.findOne({ branch: branch._id });
  if (!account) throw new HttpError(409, `${branch.name}'s account isn't ready yet`, "ACCOUNT_NOT_READY");

  if (opts.clientKey) {
    const replay = await TransferModel.find({ business: business._id, createdBy: userId, clientKey: opts.clientKey });
    if (replay.length) return { transfers: replay, batch: null, replayed: true };
  }

  for (const r of requests) {
    if (r.recipient.accountNumber === account.accountNumber) {
      throw new HttpError(400, "You can't send money to the account it's coming from", "SAME_ACCOUNT");
    }
  }

  // Quote every distinct amount before taking the lock (fees are cached per amount).
  const fees = new Map<number, Awaited<ReturnType<typeof quoteFee>>>();
  for (const amount of new Set(requests.map((r) => r.amountKobo))) fees.set(amount, await quoteFee(amount));

  const amountKobo = requests.reduce((s, r) => s + r.amountKobo, 0);
  const feeKobo = requests.reduce((s, r) => s + fees.get(r.amountKobo)!.feeKobo, 0);
  const totalKobo = amountKobo + feeKobo;
  const approval = needsApproval(business, membership, amountKobo);
  if (approval && (await eligibleApprovers(business, branch._id, userId)).length === 0) {
    throw new HttpError(
      409,
      "This transfer needs approval, but nobody else on your team can approve transfers from this branch.",
      "NO_APPROVER",
    );
  }

  const { transfers, batch } = await withAccountLock(account._id, async () => {
    const { availableKobo } = await availableBalance(account);
    if (totalKobo > availableKobo) {
      throw new HttpError(422, "There isn't enough money in this account for this transfer", "INSUFFICIENT_BALANCE", {
        availableKobo,
        requiredKobo: totalKobo,
      });
    }

    const batch =
      requests.length > 1
        ? await TransferBatchModel.create({
            business: business._id,
            branch: branch._id,
            title: opts.batchTitle,
            createdBy: userId,
            count: requests.length,
            amountKobo,
            feeKobo,
            totalKobo,
          })
        : null;

    const transfers = await TransferModel.insertMany(
      requests.map((r, i) => {
        const fee = fees.get(r.amountKobo)!;
        return {
          business: business._id,
          branch: branch._id,
          virtualAccount: account._id,
          batch: batch?._id,
          kind: r.recipient.kind,
          amountKobo: r.amountKobo,
          feeKobo: fee.feeKobo,
          stampDutyKobo: fee.stampDutyKobo,
          totalKobo: r.amountKobo + fee.feeKobo,
          recipient: {
            accountNumber: r.recipient.accountNumber,
            accountName: r.recipient.accountName,
            bankName: r.recipient.bankName,
            bankUuid: r.recipient.bankUuid,
            business: r.recipient.business,
            branch: r.recipient.branch,
          },
          narration: r.narration,
          reference: newReference(),
          status: approval ? "pending_approval" : "processing",
          createdBy: userId,
          // Only the first transfer carries the key: the unique index is per transfer.
          clientKey: i === 0 ? opts.clientKey : undefined,
          provider: { idempotencyKey: newIdempotencyKey() },
        };
      }),
    );
    return { transfers: transfers as unknown as TransferDocument[], batch };
  });

  if (approval) {
    await notifyApprovers(business, branch._id, userId, transfers, batch?.id).catch((err) => console.error("Couldn't email approvers:", err));
  } else {
    for (const transfer of transfers) await submitTransfer(transfer);
  }
  return { transfers: await TransferModel.find({ _id: { $in: transfers.map((t) => t._id) } }).sort({ _id: 1 }), batch, replayed: false };
}

// ---------------------------------------------------------------------------------------------------------
// Approving, rejecting, cancelling
// ---------------------------------------------------------------------------------------------------------

/** Approves or rejects transfers waiting for approval. The person who created them can't decide on them. */
export async function decideTransfers(opts: {
  transfers: TransferDocument[];
  membership: MembershipDocument;
  userId: string;
  decision: "approve" | "reject";
  note?: string;
}) {
  const { transfers, userId, decision, note } = opts;
  for (const transfer of transfers) {
    if (transfer.status !== "pending_approval") {
      throw new HttpError(409, "This transfer is no longer waiting for approval", "TRANSFER_NOT_PENDING");
    }
    if (transfer.createdBy.equals(userId)) {
      throw new HttpError(403, "Someone else has to approve a transfer you created", "CANNOT_APPROVE_OWN");
    }
    if (!canAccessBranch(opts.membership, transfer.branch)) throw new HttpError(404, "Transfer not found");
  }

  const decided: TransferDocument[] = [];
  for (const transfer of transfers) {
    // Conditional update, so two approvers clicking at once can't both act.
    const updated = await TransferModel.findOneAndUpdate(
      { _id: transfer._id, status: "pending_approval" },
      {
        status: decision === "approve" ? "processing" : "rejected",
        decision: { by: userId, at: new Date(), note },
        ...(decision === "reject" && { completedAt: new Date() }),
      },
      { returnDocument: "after" },
    );
    if (updated) decided.push(updated);
  }

  if (decision === "approve") {
    for (const transfer of decided) await submitTransfer(transfer);
  } else if (decided.length) {
    await notifyRejected(decided, note).catch((err) => console.error("Couldn't email the rejection:", err));
  }
  return decided;
}

/** The creator withdraws transfers that haven't been approved yet. */
export async function cancelTransfers(transfers: TransferDocument[], userId: string) {
  for (const transfer of transfers) {
    if (!transfer.createdBy.equals(userId)) throw new HttpError(403, "Only the person who created this transfer can cancel it", "PERMISSION_DENIED");
    if (transfer.status !== "pending_approval") throw new HttpError(409, "Only transfers waiting for approval can be cancelled", "TRANSFER_NOT_PENDING");
  }
  await TransferModel.updateMany(
    { _id: { $in: transfers.map((t) => t._id) }, status: "pending_approval" },
    { status: "cancelled", completedAt: new Date() },
  );
}

// ---------------------------------------------------------------------------------------------------------
// Sending to Liquifia and following up
// ---------------------------------------------------------------------------------------------------------

/** A Liquifia error that means the payout definitely wasn't created (as opposed to a timeout or outage). */
const isDefinitiveRejection = (err: unknown) =>
  err instanceof LiquifiaError && err.status >= 400 && err.status < 500 && ![408, 409, 425, 429].includes(err.status);

function failureMessage(err: unknown) {
  if (err instanceof LiquifiaError && err.code === "INSUFFICIENT_BALANCE") return "There wasn't enough money in the account";
  if (err instanceof LiquifiaError) return err.message;
  return "The transfer couldn't be completed";
}

/**
 * Hands an approved transfer to Liquifia. Safe to call again: the same idempotency key means a retry after a
 * timeout returns the payout that was already created instead of paying twice.
 */
export async function submitTransfer(transfer: TransferDocument) {
  if (transfer.status !== "processing" || transfer.provider?.payoutId) return transfer;
  const account = await VirtualAccountModel.findById(transfer.virtualAccount);
  if (!account) throw new Error(`Virtual account ${transfer.virtualAccount} not found`);

  transfer.set({ "provider.attempts": (transfer.provider?.attempts ?? 0) + 1, "provider.lastCheckedAt": new Date() });
  try {
    const payout = await liquifia.createPayout(
      {
        virtual_account_id: account.providerAccountId,
        amount: toNaira(transfer.amountKobo),
        destination_account: transfer.recipient!.accountNumber,
        destination_bank_uuid: transfer.recipient!.bankUuid,
        reference: transfer.reference,
        narration: transfer.narration ?? undefined,
      },
      transfer.provider!.idempotencyKey,
    );
    transfer.set({
      "provider.payoutId": payout.id,
      "provider.status": payout.status,
      "provider.lastError": undefined,
      "provider.data": payout,
      submittedAt: transfer.submittedAt ?? new Date(),
    });
    await transfer.save();
    await recordPayoutTransaction(transfer);
    return applyPayoutStatus(transfer, payout.status, payout);
  } catch (err) {
    if (isDefinitiveRejection(err)) {
      transfer.set({ status: "failed", failureReason: failureMessage(err), completedAt: new Date(), "provider.lastError": String(err) });
      await transfer.save();
      notifyFailed(transfer).catch((e) => console.error("Couldn't email the failure:", e));
      return transfer;
    }
    // Unknown outcome: keep holding the money and retry with the same key (processOpenTransfers).
    transfer.set({ "provider.lastError": err instanceof Error ? err.message : String(err) });
    await transfer.save();
    console.error(`Payout for transfer ${transfer.id} didn't go through yet:`, err);
    return transfer;
  }
}

/** The debit on the source account, shown with the business's transactions. */
async function recordPayoutTransaction(transfer: TransferDocument) {
  await TransactionModel.updateOne(
    { providerTransactionId: transfer.provider!.payoutId },
    {
      $set: { status: mapTransactionStatus(transfer.status) },
      $setOnInsert: {
        business: transfer.business,
        branch: transfer.branch,
        virtualAccount: transfer.virtualAccount,
        transfer: transfer._id,
        type: "payout",
        direction: "debit",
        amountKobo: transfer.amountKobo,
        feeKobo: transfer.feeKobo,
        // For debits, everything that left the account (amount + fee).
        netKobo: transfer.totalKobo,
        currency: transfer.currency,
        counterparty: {
          name: transfer.recipient!.accountName,
          bankName: transfer.recipient!.bankName,
          accountNumber: transfer.recipient!.accountNumber,
        },
        narration: transfer.narration,
        reference: transfer.reference,
        provider: "liquifia",
        occurredAt: transfer.submittedAt ?? new Date(),
      },
    },
    { upsert: true },
  );
}

const mapTransactionStatus = (status: string) => (status === "success" ? "success" : status === "failed" ? "failed" : "pending");

/** Moves the transfer to success or failed when Liquifia says so. */
async function applyPayoutStatus(transfer: TransferDocument, providerStatus: string, data?: unknown) {
  const status = providerStatus?.toLowerCase();
  const wasOpen = transfer.status === "processing";
  transfer.set({ "provider.status": status, "provider.lastCheckedAt": new Date(), ...(data !== undefined && { "provider.data": data }) });
  if (status === "success" || status === "failed") {
    transfer.set({
      status,
      completedAt: new Date(),
      ...(status === "failed" && { failureReason: transfer.failureReason ?? "The bank couldn't complete the transfer" }),
    });
  }
  await transfer.save();
  if (transfer.provider?.payoutId) {
    await TransactionModel.updateOne({ providerTransactionId: transfer.provider.payoutId }, { status: mapTransactionStatus(transfer.status) });
  }
  if (wasOpen && transfer.status === "failed") notifyFailed(transfer).catch((e) => console.error("Couldn't email the failure:", e));
  return transfer;
}

/** Asks Liquifia for the latest on one transfer (or sends it again if Liquifia never accepted it). */
export async function refreshTransfer(transfer: TransferDocument) {
  if (transfer.status !== "processing") return transfer;
  if (!transfer.provider?.payoutId) return submitTransfer(transfer);
  const payout = await liquifia.getPayout(transfer.provider.payoutId);
  return applyPayoutStatus(transfer, payout.status, payout);
}

/** Follows up every transfer still in progress. Run in the background and when payout webhooks arrive. */
export async function processOpenTransfers({ minAgeMs = 0 } = {}) {
  const stale = new Date(Date.now() - minAgeMs);
  const open = await TransferModel.find({
    status: "processing",
    $or: [{ "provider.lastCheckedAt": { $exists: false } }, { "provider.lastCheckedAt": { $lte: stale } }],
  })
    .sort({ "provider.lastCheckedAt": 1 })
    .limit(200);
  const counts = { checked: 0, success: 0, failed: 0, errors: 0 };
  for (const transfer of open) {
    try {
      const after = await refreshTransfer(transfer);
      counts.checked++;
      if (after.status === "success") counts.success++;
      if (after.status === "failed") counts.failed++;
    } catch (err) {
      counts.errors++;
      await TransferModel.updateOne({ _id: transfer._id }, { "provider.lastCheckedAt": new Date(), "provider.lastError": String(err) });
      console.error(`Couldn't check transfer ${transfer.id}:`, err);
    }
  }
  return counts;
}

let running: Promise<unknown> | null = null;

/** Starts following up open transfers in the background (not used in tests). */
export function startTransferProcessor(intervalMs: number) {
  if (intervalMs <= 0) return () => {};
  const tick = () => {
    if (running) return;
    running = processOpenTransfers({ minAgeMs: intervalMs / 2 })
      .catch((err) => console.error("Transfer follow-up failed:", err))
      .finally(() => {
        running = null;
      });
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
}

// ---------------------------------------------------------------------------------------------------------
// Emails
// ---------------------------------------------------------------------------------------------------------

async function notifyApprovers(
  business: BusinessDocument,
  branchId: Types.ObjectId,
  creatorId: string,
  transfers: TransferDocument[],
  batchId?: string,
) {
  const [approverIds, creator] = await Promise.all([eligibleApprovers(business, branchId, creatorId), UserModel.findById(creatorId).select("name")]);
  const approvers = await UserModel.find({ _id: { $in: approverIds } }).select("email");
  const amountKobo = transfers.reduce((s, t) => s + t.amountKobo, 0);
  for (const approver of approvers) {
    await sendTransferAwaitingApprovalEmail(approver.email, {
      businessName: business.name,
      creatorName: creator?.name ?? "A team member",
      amountKobo,
      count: transfers.length,
      recipientName: transfers.length === 1 ? transfers[0]!.recipient!.accountName : undefined,
      path: batchId ? `/transfers?batch=${batchId}` : `/transfers?transfer=${transfers[0]!.id}`,
    });
  }
}

async function notifyRejected(transfers: TransferDocument[], note?: string) {
  const creator = await UserModel.findById(transfers[0]!.createdBy).select("email");
  if (!creator) return;
  await sendTransferRejectedEmail(creator.email, {
    amountKobo: transfers.reduce((s, t) => s + t.amountKobo, 0),
    count: transfers.length,
    recipientName: transfers.length === 1 ? transfers[0]!.recipient!.accountName : undefined,
    note,
  });
}

async function notifyFailed(transfer: TransferDocument) {
  const creator = await UserModel.findById(transfer.createdBy).select("email");
  if (!creator) return;
  await sendTransferFailedEmail(creator.email, {
    amountKobo: transfer.amountKobo,
    recipientName: transfer.recipient!.accountName,
    reason: transfer.failureReason ?? undefined,
  });
}
