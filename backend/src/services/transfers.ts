import { createHash, randomBytes } from "node:crypto";
import { Types } from "mongoose";
import { env } from "../config/env";
import { rateLimitSettings } from "../middleware/rateLimits";
import { BeneficiaryModel } from "../models/Beneficiary";
import { BranchModel } from "../models/Branch";
import type { BusinessDocument } from "../models/Business";
import { BusinessModel } from "../models/Business";
import { MembershipModel, type MembershipDocument } from "../models/Membership";
import { RateLimitHitModel } from "../models/RateLimitHit";
import { TransactionModel } from "../models/Transaction";
import {
  OPEN_TRANSFER_STATUSES,
  TransferBatchModel,
  TransferModel,
  type TransferDocument,
  type TransferKind,
  type TransferStatus,
} from "../models/Transfer";
import { UserModel } from "../models/User";
import { VirtualAccountModel } from "../models/VirtualAccount";
import { HttpError } from "../utils/HttpError";
import { assertSameRequest, isDuplicateClientKey, requestHash } from "../utils/idempotency";
import { inPool } from "../utils/pool";
import { sendTransferAwaitingApprovalEmail, sendTransferFailedEmail, sendTransferRejectedEmail } from "./email";
import { liquifia, LiquifiaError, newIdempotencyKey, PAYOUT_STATUSES, toKobo, toNaira, type LiquifiaBank, type LiquifiaPayout } from "./liquifia/client";
import { transferApprovalRequested, transferSettled, transfersDecided, transferStuck } from "./notificationEvents";
import { assertMoneyCanMove } from "./compliance";
import { savedByAccount } from "./savings";
import {
  approvalPlan,
  approversForBranch,
  assertCanDecide,
  assertPlanReachable,
  canDecide,
  currentLevel,
  initialApproval,
  levelApprovers,
  levelsOf,
  type PlannedLevel,
} from "./approvals";
import { canAccessBranch, ensureOwnerMembership, hasPermission } from "./team";

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

// Name enquiries answered in the last few minutes, by bank and account number. Only the bulk review reads them
// (resolve-accounts and the preview), so a review and its preview don't ask the bank twice for 200 rows.
// Sending always asks the bank afresh, and refreshes the entry. Successful answers only.
const NAME_TTL_MS = 5 * 60_000;
const NAME_CACHE_MAX = 5_000;
const nameCache = new Map<string, { at: number; accountName: string; bankName?: string }>();

/** 4xx answers that mean "try again later" (timeout, too early, too many requests), not "no such account". */
const TRY_AGAIN_STATUSES = [408, 425, 429];

/** Empties the name-enquiry cache (tests). */
export const clearNameCache = () => nameCache.clear();

/** The bank's name check gave no answer just now: an outage, not "no such account", so it's worth asking again. */
export const nameCheckUnavailable = () =>
  new HttpError(502, "We couldn't check this account with the bank right now. Try again in a moment.", "NAME_CHECK_UNAVAILABLE");

/** Looks the account up with the bank (name enquiry) and notes when it's an account on LinkPay. */
export async function resolveBankRecipient(
  business: BusinessDocument,
  accountNumber: string,
  bankUuid: string,
  opts: { cached?: boolean } = {},
): Promise<ResolvedRecipient> {
  const bank = (await listBanks()).find((b) => b.uuid === bankUuid);
  if (!bank) throw new HttpError(400, "Choose a bank from the list", "INVALID_BANK");

  const key = `${bankUuid}:${accountNumber}`;
  const hit = opts.cached ? nameCache.get(key) : undefined;
  let found = hit && Date.now() - hit.at < NAME_TTL_MS ? { accountName: hit.accountName, bankName: hit.bankName } : null;
  if (!found) {
    let lookup;
    try {
      lookup = await liquifia.validateAccount(accountNumber, bankUuid);
    } catch (err) {
      // An answer without a usable name says nothing about whether the account exists. It's about this account
      // (a bulk row shows it and the rest go on), and asking again may work, so it isn't cached.
      if (err instanceof LiquifiaError && err.code === "UNEXPECTED_RESPONSE") {
        console.error(`Name enquiry failed: ${err.message}`);
        throw nameCheckUnavailable();
      }
      // Throttled or timed out: the service, not the account, like a 5xx (the whole bulk call fails, to be retried).
      if (err instanceof LiquifiaError && TRY_AGAIN_STATUSES.includes(err.status)) throw err;
      if (err instanceof LiquifiaError && err.status >= 400 && err.status < 500) {
        throw new HttpError(422, "We couldn't find that account. Check the number and bank.", "ACCOUNT_NOT_FOUND");
      }
      throw err;
    }
    found = { accountName: lookup.account_name, bankName: lookup.bank_name ?? bank.name };
    nameCache.delete(key);
    nameCache.set(key, { at: Date.now(), ...found });
    // Oldest first: Map keeps insertion order.
    if (nameCache.size > NAME_CACHE_MAX) nameCache.delete(nameCache.keys().next().value!);
  }

  return classifyRecipient(business, { kind: "bank", accountNumber, accountName: found.accountName, bankName: found.bankName, bankUuid });
}

/**
 * An account name as compared when a bulk row says which name the member reviewed: letters and digits only,
 * lower case, accents dropped. "Obi, Amaka-Jane" and "OBI AMAKA JANE" are the same name; word order counts.
 */
export const normaliseAccountName = (name: string) =>
  name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");

export const sameAccountName = (a: string, b: string) => {
  const x = normaliseAccountName(a);
  return x.length > 0 && x === normaliseAccountName(b);
};

export type ResolvedRow =
  | { row: number; accountNumber: string; bankUuid: string; accountName: string; bankName: string | null; kind: TransferKind; label: string | null }
  | { row: number; accountNumber: string; bankUuid: string; error: string; code?: string };

/**
 * Name enquiries for a bulk review: a result per row, the name or why it failed. Five at a time, each account
 * asked once however many rows pay it, and answers from the last few minutes reused. A failure that isn't
 * about the row (the bank's service is down) fails the whole call, so it can be tried again.
 */
export async function resolveBankRecipients(business: BusinessDocument, rows: { accountNumber: string; bankUuid: string }[]) {
  const keyOf = (r: { accountNumber: string; bankUuid: string }) => `${r.bankUuid}:${r.accountNumber}`;
  const distinct = [...new Map(rows.map((r) => [keyOf(r), r])).values()];
  const answers = new Map<string, ResolvedRecipient | HttpError>();
  await inPool(distinct, 5, async (r) => {
    try {
      if (!/^\d{10}$/.test(r.accountNumber)) throw new HttpError(400, "Account numbers are 10 digits", "INVALID_ACCOUNT_NUMBER");
      answers.set(keyOf(r), await resolveBankRecipient(business, r.accountNumber, r.bankUuid, { cached: true }));
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      answers.set(keyOf(r), err);
    }
  });
  return rows.map((r, row): ResolvedRow => {
    const answer = answers.get(keyOf(r))!;
    const base = { row, accountNumber: r.accountNumber, bankUuid: r.bankUuid };
    if (answer instanceof HttpError) return { ...base, error: answer.message, code: answer.code };
    return { ...base, accountName: answer.accountName, bankName: answer.bankName ?? null, kind: answer.kind, label: answer.label ?? null };
  });
}

/**
 * Notes when a bank recipient is one of our accounts: a branch of this business (internal) or another
 * business on LinkPay. Database only, no name enquiry. Refuses closed (banned) businesses.
 */
export async function classifyRecipient(business: BusinessDocument, recipient: ResolvedRecipient): Promise<ResolvedRecipient> {
  const { accountNumber, bankUuid } = recipient;
  const ours = await VirtualAccountModel.findOne({ accountNumber }).select("business branch bankUuid bankName");
  if (ours && (!ours.bankUuid || ours.bankUuid === bankUuid)) {
    const branch = ours.branch ? await BranchModel.findById(ours.branch).select("name isHeadOffice") : null;
    if (ours.business.equals(business._id)) {
      return { ...recipient, kind: "internal", business: ours.business, branch: ours.branch ?? undefined, label: branch?.name };
    }
    const other = await BusinessModel.findById(ours.business).select("name compliance.status");
    if (other?.compliance?.status === "banned") {
      throw new HttpError(422, "This account can't receive transfers.", "RECIPIENT_UNAVAILABLE");
    }
    return { ...recipient, kind: "linkpay", business: ours.business, branch: ours.branch ?? undefined, label: other?.name };
  }
  return { ...recipient, kind: "bank", business: undefined, branch: undefined, label: undefined };
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

/** A fee in kobo we can hold and charge: a whole number, at least 0. */
const isFeeKobo = (kobo: number) => Number.isSafeInteger(kobo) && kobo >= 0;

/**
 * Liquifia's fee for a payout of this amount, including the ₦50 stamp duty on ₦10,000 or more. The quote's shape
 * is checked (liquifia.quotePayoutFee), and only a usable answer is cached: a NaN fee would pass the balance
 * check (`total > available` is false) and be reused for 10 minutes.
 */
export async function quoteFee(amountKobo: number) {
  const cached = feeCache.get(amountKobo);
  if (cached && Date.now() - cached.at < FEE_TTL_MS) return { feeKobo: cached.feeKobo, stampDutyKobo: cached.stampDutyKobo };
  const quote = await liquifia.quotePayoutFee(toNaira(amountKobo));
  const result = { feeKobo: toKobo(quote.fee), stampDutyKobo: toKobo(quote.stamp_duty) };
  if (!isFeeKobo(result.feeKobo) || !isFeeKobo(result.stampDutyKobo)) {
    throw new LiquifiaError(0, "UNEXPECTED_RESPONSE", `Liquifia's fee quote for ${amountKobo} kobo isn't a usable amount`);
  }
  feeCache.set(amountKobo, { at: Date.now(), ...result });
  return result;
}

// ---------------------------------------------------------------------------------------------------------
// The name-check budget
// ---------------------------------------------------------------------------------------------------------

/**
 * Name enquiries one member may cause in 15 minutes, across everything that asks the bank whose account it is
 * and shows the answer: `resolve-account`, `resolve-accounts`, the bulk preview, and saving beneficiaries (one
 * at a time or imported). 600 is three 200-row files' worth of new accounts: room to check an upload, fix it and
 * check the fixes, or to import a payroll sheet, while one member can look up at most 2,400 names an hour and
 * can't make Liquifia throttle every business. Answers the bulk review reuses from the 5-minute cache cost
 * nothing, so checking the same rows again is free. Sending isn't counted: it needs the PIN, and a payment must
 * never be refused because its rows were reviewed first.
 */
export const NAME_CHECKS_PER_WINDOW = 600;
const NAME_CHECK_WINDOW_MS = 15 * 60_000;

/** How many of these accounts a name enquiry would ask the bank about now: distinct, well-formed, not in the cache. */
export function uncachedNameChecks(rows: { accountNumber: string; bankUuid: string }[]) {
  const now = Date.now();
  const keys = new Set(rows.filter((r) => /^\d{10}$/.test(r.accountNumber)).map((r) => `${r.bankUuid}:${r.accountNumber}`));
  return [...keys].filter((key) => {
    const hit = nameCache.get(key);
    return !hit || now - hit.at >= NAME_TTL_MS;
  }).length;
}

const nameChecksExhausted = (counter: { hits: number; resetAt: Date } | null, wanted: number) => {
  const retryAt = counter?.resetAt ?? new Date(Date.now() + NAME_CHECK_WINDOW_MS);
  const minutes = Math.max(1, Math.ceil((retryAt.getTime() - Date.now()) / 60_000));
  return new HttpError(
    429,
    `You've checked a lot of accounts with the bank in the last few minutes. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
    "RATE_LIMITED",
    { retryAt, limit: NAME_CHECKS_PER_WINDOW, remaining: Math.max(0, NAME_CHECKS_PER_WINDOW - (counter?.hits ?? 0)), requested: wanted },
  );
};

/**
 * Takes `n` name checks from the member's budget (NAME_CHECKS_PER_WINDOW per 15 minutes), all or nothing,
 * before the bank is asked; refuses with 429 RATE_LIMITED (`details: { retryAt, limit, remaining, requested }`)
 * when there isn't room, and nothing is checked. Counted in MongoDB next to the other rate limits
 * (RateLimitHit), so it holds across restarts and instances; each write is a single conditional update, so
 * requests at the same moment can't both take the last of it. Off in tests unless rate limits are turned on,
 * and, like the other limits, lets requests through (logging it) if the counter can't be written.
 */
export async function spendNameChecks(userId: string, n: number) {
  if (n <= 0 || (env.nodeEnv === "test" && !rateLimitSettings.enabledInTests)) return;
  const key = `name-checks:${createHash("sha256").update(`user:${userId}`).digest("base64url")}`;
  if (n > NAME_CHECKS_PER_WINDOW) throw nameChecksExhausted(null, n);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      // This instance's clock decides the window (an upsert can't filter on MongoDB's): a few seconds' drift
      // between instances only moves where a 15-minute window ends.
      const now = new Date();
      // Room in the current window: add these to it.
      const added = await RateLimitHitModel.updateOne(
        { key, resetAt: { $gt: now }, hits: { $lte: NAME_CHECKS_PER_WINDOW - n } },
        { $inc: { hits: n } },
      );
      if (added.matchedCount) return;
      // No current window (none yet, or the last one is over): start one with these. If there is a current one,
      // the insert hits its key, and it has no room (unless another request started it just now: look again).
      try {
        const started = await RateLimitHitModel.updateOne(
          { key, resetAt: { $lte: now } },
          { $set: { hits: n, resetAt: new Date(now.getTime() + NAME_CHECK_WINDOW_MS) } },
          { upsert: true },
        );
        if (started.matchedCount || started.upsertedCount) return;
      } catch (err: any) {
        if (err?.code !== 11000) throw err;
      }
    }
  } catch (err) {
    console.error("The name-check budget can't reach MongoDB: name checks are NOT being limited.", err);
    return;
  }
  throw nameChecksExhausted(await RateLimitHitModel.findOne({ key }).lean(), n);
}

// ---------------------------------------------------------------------------------------------------------
// Balances and holds
// ---------------------------------------------------------------------------------------------------------

/**
 * What our side still holds on each account: every transfer that hasn't succeeded or failed yet, whether it's
 * waiting for approval or already with Liquifia. Once Liquifia has accepted a payout its balance may already
 * show the debit, so until the payout settles that money is counted twice (and `availableKobo` can go below
 * zero). That's the safe direction while nobody has confirmed when the debit lands on a live account. If
 * Liquifia confirms the debit lands as soon as it accepts a payout, this can go back to holding only transfers
 * without a `provider.payoutId`.
 */
export async function heldByAccount(accountIds: Types.ObjectId[]) {
  const rows = await TransferModel.aggregate<{ _id: Types.ObjectId; heldKobo: number }>([
    { $match: { virtualAccount: { $in: accountIds }, status: { $in: OPEN_TRANSFER_STATUSES } } },
    { $group: { _id: "$virtualAccount", heldKobo: { $sum: "$totalKobo" } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.heldKobo]));
}

/** How long the balance check may wait on Liquifia: well inside LOCK_MS, so the lock can't run out while it waits. */
const BALANCE_TIMEOUT_MS = 10_000;

/** What can be spent: Liquifia's balance less transfer holds and money set aside in savings. Can be below zero. */
export async function availableBalance(account: { _id: Types.ObjectId; providerAccountId: string }) {
  const [balance, held, saved] = await Promise.all([
    liquifia.getVirtualAccountBalance(account.providerAccountId, { timeoutMs: BALANCE_TIMEOUT_MS }),
    heldByAccount([account._id]),
    savedByAccount([account._id]),
  ]);
  const balanceKobo = Math.round(balance.balance);
  const heldKobo = held.get(String(account._id)) ?? 0;
  const savedKobo = saved.get(String(account._id)) ?? 0;
  return { balanceKobo, heldKobo, savedKobo, availableKobo: balanceKobo - heldKobo - savedKobo };
}

const LOCK_MS = 60_000;

const accountBusy = () => new HttpError(409, "Another payment from this account is in progress. Try again in a moment.", "ACCOUNT_BUSY");

export type AccountLock = {
  /**
   * Call right before the writes that rely on the balance check. Checks the lock is still ours and extends it;
   * if it ran out and someone else took it, throws ACCOUNT_BUSY so nothing is written on a stale check.
   */
  confirm: () => Promise<void>;
};

/** Runs `fn` while holding a short lock on the account, so two transfers (or savings moves) can't spend the same money. */
export async function withAccountLock<T>(accountId: Types.ObjectId, fn: (lock: AccountLock) => Promise<T>): Promise<T> {
  const token = randomBytes(16).toString("hex");
  const lock: AccountLock = {
    confirm: async () => {
      const now = new Date();
      const ours = await VirtualAccountModel.updateOne(
        { _id: accountId, lockToken: token, lockedUntil: { $gt: now } },
        { lockedUntil: new Date(now.getTime() + LOCK_MS) },
      );
      if (ours.matchedCount === 0) throw accountBusy();
    },
  };
  for (let attempt = 0; attempt < 50; attempt++) {
    const now = new Date();
    const locked = await VirtualAccountModel.findOneAndUpdate(
      { _id: accountId, $or: [{ lockedUntil: { $exists: false } }, { lockedUntil: null }, { lockedUntil: { $lt: now } }] },
      { lockedUntil: new Date(now.getTime() + LOCK_MS), lockToken: token },
    );
    if (locked) {
      try {
        return await fn(lock);
      } finally {
        // Only our own lock: if ours ran out and someone else holds it now, theirs stays.
        await VirtualAccountModel.updateOne({ _id: accountId, lockToken: token }, { $unset: { lockedUntil: 1, lockToken: 1 } });
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw accountBusy();
}

// ---------------------------------------------------------------------------------------------------------
// Creating transfers
// ---------------------------------------------------------------------------------------------------------

export type TransferRequest = {
  recipient: ResolvedRecipient;
  amountKobo: number;
  narration?: string;
  /** The saved beneficiary being paid, if any. */
  beneficiary?: Types.ObjectId;
};

const newReference = () => `LPB${randomBytes(8).toString("hex").toUpperCase()}`;

/** Would a transfer of this amount alone need approval? Sending also counts the member's last 24 hours (planForRequest). */
export function needsApproval(business: BusinessDocument, membership: MembershipDocument, totalAmountKobo: number) {
  return approvalPlan(business, membership, totalAmountKobo).length > 0;
}

/** How far back a member's own transfers from a branch count towards the amount that decides approval. */
export const APPROVAL_WINDOW_MS = 24 * 60 * 60_000;
/** Transfers that never sent money, or never will: they don't count towards that amount. */
const NOT_SENT: TransferStatus[] = ["failed", "rejected", "cancelled"];

/**
 * What this member created from this branch in the last 24 hours, amounts before fees: every transfer
 * waiting for approval, in progress or sent.
 */
export async function recentTotalKobo(userId: string | Types.ObjectId, branchId: Types.ObjectId, now = new Date()) {
  const [row] = await TransferModel.aggregate<{ totalKobo: number }>([
    {
      $match: {
        createdBy: new Types.ObjectId(String(userId)),
        branch: branchId,
        createdAt: { $gte: new Date(now.getTime() - APPROVAL_WINDOW_MS) },
        status: { $nin: NOT_SENT },
      },
    },
    { $group: { _id: null, totalKobo: { $sum: "$amountKobo" } } },
  ]);
  return row?.totalKobo ?? 0;
}

/**
 * The approval levels a request of `amountKobo` needs (a whole batch for bulk transfers and payout-list runs).
 * The amount that decides it, and the tier of a workflow, is the larger of the request and the member's
 * 24-hour total from this branch including it, so splitting one payment into several smaller ones doesn't
 * get round the rule. Sending calls this under the account lock, so two requests at once can't both slip under.
 */
export async function planForRequest(opts: {
  business: BusinessDocument;
  membership: MembershipDocument;
  userId: string;
  branchId: Types.ObjectId;
  amountKobo: number;
}) {
  const earlierKobo = await recentTotalKobo(opts.userId, opts.branchId);
  const decidingKobo = Math.max(opts.amountKobo, earlierKobo + opts.amountKobo);
  return { plan: approvalPlan(opts.business, opts.membership, decidingKobo), earlierKobo, decidingKobo };
}

/**
 * What an Idempotency-Key's request hash covers in each row: where the money goes (the account and its bank),
 * how much, and the narration. `beneficiary` is only for LEGACY_SEND_HASH records.
 */
export type KeyedRow = {
  accountNumber: string;
  bankUuid: string;
  amountKobo: number;
  narration?: string | null;
  beneficiary?: Types.ObjectId | string | null;
};

/**
 * What a request asks for, so the same Idempotency-Key with different details is refused: the account it's sent
 * from, the payout list it runs (if any), and each row's account, bank, amount and narration. Left out:
 * - the batch title: it moves no money, and a payout list's default title carries the date, so a retry after
 *   midnight would be refused (and the client could then send it again under a new key);
 * - the account name a row was reviewed with: a check on the recipient (resolvePayoutRows), not part of the
 *   payment, so a retry after the name was checked again replays;
 * - the saved beneficiary a row is paid as, and whether the request saves new ones (`saveBeneficiary`,
 *   `saveBeneficiaries`): a row is the account it pays, whether it names a beneficiary or the account, and
 *   whether or not saving gave it a beneficiary id on the first attempt. A retry that unticks (or ticks)
 *   "save" must replay, not be refused and then sent again under a new key. The apps' keys follow the same
 *   details (the account, recipient, amount and narration per row).
 * The shape must not change: stored hashes are compared with it.
 */
function sendRequestHash(branchId: Types.ObjectId, payoutList: Types.ObjectId | undefined, rows: KeyedRow[]) {
  return requestHash({
    v: 2,
    branch: String(branchId),
    payoutList: payoutList ? String(payoutList) : null,
    rows: rows.map((r) => ({ accountNumber: r.accountNumber, bankUuid: r.bankUuid, amountKobo: r.amountKobo, narration: r.narration ?? null })),
  });
}

/**
 * The hash transfers stored until 2026-10-25, which also held each row's beneficiary id. Still accepted, so a
 * retry of a request first sent before then replays (Liquifia and the apps retry within hours). It can go once
 * no transfer from before then can be retried.
 */
function legacySendHash(branchId: Types.ObjectId, payoutList: Types.ObjectId | undefined, rows: KeyedRow[]) {
  return requestHash({
    branch: String(branchId),
    payoutList: payoutList ? String(payoutList) : null,
    rows: rows.map((r) => ({
      accountNumber: r.accountNumber,
      bankUuid: r.bankUuid,
      amountKobo: r.amountKobo,
      narration: r.narration ?? null,
      beneficiary: r.beneficiary ? String(r.beneficiary) : null,
    })),
  });
}

/** The hashes a stored Idempotency-Key record may have for this request: today's shape, and the one before. */
const acceptedSendHashes = (branchId: Types.ObjectId, payoutList: Types.ObjectId | undefined, rows: KeyedRow[]) => [
  sendRequestHash(branchId, payoutList, rows),
  legacySendHash(branchId, payoutList, rows),
];

/** The first transfer this member sent with this Idempotency-Key, if any. */
const firstWithKey = (business: BusinessDocument, userId: string, clientKey: string) =>
  TransferModel.findOne({ business: business._id, createdBy: userId, clientKey });

/** The answer to a replay: the transfer the key created, or its whole batch. */
async function replayOf(first: TransferDocument) {
  if (!first.batch) return { transfers: [first], batch: null, replayed: true as const };
  const [transfers, batch] = await Promise.all([TransferModel.find({ batch: first.batch }).sort({ _id: 1 }), TransferBatchModel.findById(first.batch)]);
  return { transfers, batch, replayed: true as const };
}

/** The branch money leaves from, and its account, if the member may send from it. Database only. */
async function sendingAccount(business: BusinessDocument, membership: MembershipDocument, branchId: string) {
  const branch = await BranchModel.findOne({ _id: branchId, business: business._id });
  if (!branch || !canAccessBranch(membership, branch._id)) throw new HttpError(404, "Branch not found");
  const account = await VirtualAccountModel.findOne({ branch: branch._id });
  if (!account) throw new HttpError(409, `${branch.name}'s account isn't ready yet`, "ACCOUNT_NOT_READY");
  return { branch, account };
}

/**
 * A retry's answer, found before the recipients are looked up with the bank: a client retrying its
 * Idempotency-Key while the bank is down gets the replay of what it first sent (or IDEMPOTENCY_KEY_REUSED if
 * the details changed), not a 502. When the key has been used, `rows` works out the hashed details from the
 * request and `sent`, what the key created, never from beneficiaries or lists as they are now
 * (keyedPayoutRows, keyedBranchRow, keyedTransferRow): a beneficiary the first request paid, or saved, may have
 * been deleted or saved again since, and refusing the retry then (404, INVALID_ROWS or IDEMPOTENCY_KEY_REUSED)
 * would have the client send it again under a new key and pay twice. With no transfer for the key yet, the
 * caller carries on as usual, and createTransfers checks the key again after the lookups and under the lock.
 *
 * A payout list run can leave the account and the rows to the list, which may have changed or gone since:
 * then `branchId` is left out (the key's first transfer says where it was sent from) and `rows` reads them
 * from `sent` (keyedTransferRow).
 */
export async function replayBeforeLookups(opts: {
  business: BusinessDocument;
  membership: MembershipDocument;
  userId: string;
  branchId?: string;
  payoutList?: Types.ObjectId;
  clientKey?: string;
  rows: (sent: TransferDocument[]) => KeyedRow[] | Promise<KeyedRow[]>;
}) {
  if (!opts.clientKey) return null;
  const first = await firstWithKey(opts.business, opts.userId, opts.clientKey);
  if (!first) return null;
  // The same refusals as sending, so a retry can't get round them (a suspended business, a branch taken away).
  assertMoneyCanMove(opts.business);
  const { branch } = await sendingAccount(opts.business, opts.membership, opts.branchId ?? String(first.branch));
  const replay = await replayOf(first);
  assertSameRequest(first.requestHash, acceptedSendHashes(branch._id, opts.payoutList, await opts.rows(replay.transfers)));
  return replay;
}

/** A transfer as its Idempotency-Key hash saw the row it was made from. */
export const keyedTransferRow = (t: TransferDocument): KeyedRow => ({
  accountNumber: t.recipient!.accountNumber,
  bankUuid: t.recipient!.bankUuid,
  amountKobo: t.amountKobo,
  narration: t.narration,
  beneficiary: t.recipient!.beneficiary,
});

/**
 * A transfer to one of the business's own branches, as its Idempotency-Key hash saw it, from `sent` (what the
 * key created): the branch account it was paid into. If the key paid something else, the account is left
 * empty, so the hash can't match and the key is refused as reused.
 */
export function keyedBranchRow(branchId: string, row: { amountKobo: number; narration?: string }, sent: TransferDocument[]): KeyedRow {
  const paid = sent[0]?.kind === "internal" && sent[0].recipient?.branch && String(sent[0].recipient.branch) === branchId ? sent[0].recipient : null;
  return { accountNumber: paid?.accountNumber ?? "", bankUuid: paid?.bankUuid ?? "", amountKobo: row.amountKobo, narration: row.narration };
}

/**
 * The business's approval rule and the member's membership read again (createTransfers does this under the
 * account lock), refusing a member who has been removed (403 NOT_A_MEMBER), can no longer send (403
 * PERMISSION_DENIED) or no longer has the branch (404, as when sending from it).
 */
async function currentSender(business: BusinessDocument, userId: string, branchId: Types.ObjectId) {
  const fresh = (await BusinessModel.findById(business._id).select("owner transferApproval")) ?? business;
  let membership = await MembershipModel.findOne({ business: business._id, user: userId });
  // The owner's membership is made when it's first needed, so it can't be missing for them.
  if (!membership && fresh.owner?.equals(userId)) membership = await ensureOwnerMembership(fresh);
  if (!membership) throw new HttpError(403, "You're not a member of this business", "NOT_A_MEMBER");
  if (!hasPermission(membership, "transfers.create")) throw new HttpError(403, "Your role doesn't allow this", "PERMISSION_DENIED");
  if (!canAccessBranch(membership, branchId)) throw new HttpError(404, "Branch not found");
  return { business: fresh, membership };
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
  /** The saved payout list a batch was run from. */
  payoutList?: Types.ObjectId;
  clientKey?: string;
}) {
  const { business, membership, userId, requests } = opts;
  assertMoneyCanMove(business);
  const { branch, account } = await sendingAccount(business, membership, opts.branchId);

  const keyed: KeyedRow[] = requests.map((r) => ({
    accountNumber: r.recipient.accountNumber,
    bankUuid: r.recipient.bankUuid,
    amountKobo: r.amountKobo,
    narration: r.narration,
    beneficiary: r.beneficiary,
  }));
  const hash = opts.clientKey ? sendRequestHash(branch._id, opts.payoutList, keyed) : undefined;

  /** What was created the first time this Idempotency-Key was used, if it was. */
  const replay = async () => {
    if (!opts.clientKey) return null;
    const first = await firstWithKey(business, userId, opts.clientKey);
    if (!first) return null;
    assertSameRequest(first.requestHash, acceptedSendHashes(branch._id, opts.payoutList, keyed));
    return replayOf(first);
  };

  const earlier = await replay();
  if (earlier) return earlier;

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
  let plan: PlannedLevel[] = [];

  const created = await withAccountLock(account._id, async (lock) => {
    // Again under the lock: a request with the same key that was running alongside this one has finished by now.
    const replayed = await replay();
    if (replayed) return replayed;

    // Under the lock, so the member's 24-hour total includes anything they sent from this account just before,
    // and with the approval rule and the member's role as they are now: a big bulk transfer can take a minute
    // or more to get here (200 name checks, fee quotes), and mustn't go out under a rule the owner has since
    // tightened, or for someone who has since been removed or lost the right to send.
    const sender = await currentSender(business, userId, branch._id);
    plan = (await planForRequest({ business: sender.business, membership: sender.membership, userId, branchId: branch._id, amountKobo })).plan;
    await assertPlanReachable(sender.business, branch._id, plan, userId);

    const { availableKobo } = await availableBalance(account);
    if (totalKobo > availableKobo) {
      throw new HttpError(422, "There isn't enough money in this account for this transfer", "INSUFFICIENT_BALANCE", {
        availableKobo: Math.max(0, availableKobo),
        requiredKobo: totalKobo,
      });
    }
    await lock.confirm();

    const batch =
      requests.length > 1
        ? await TransferBatchModel.create({
            business: business._id,
            branch: branch._id,
            title: opts.batchTitle,
            payoutList: opts.payoutList,
            createdBy: userId,
            count: requests.length,
            amountKobo,
            feeKobo,
            totalKobo,
          })
        : null;

    let transfers;
    try {
      transfers = await TransferModel.insertMany(
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
              beneficiary: r.beneficiary,
            },
            narration: r.narration,
            reference: newReference(),
            status: plan.length > 0 ? "pending_approval" : "processing",
            createdBy: userId,
            approval: initialApproval(plan),
            // Only the first transfer carries the key: the unique index is per transfer.
            clientKey: i === 0 ? opts.clientKey : undefined,
            requestHash: i === 0 ? hash : undefined,
            provider: { idempotencyKey: newIdempotencyKey() },
          };
        }),
      );
    } catch (err) {
      // If nothing was saved under the batch, don't leave it behind.
      if (batch && !(await TransferModel.exists({ batch: batch._id }))) await TransferBatchModel.deleteOne({ _id: batch._id });
      // A request with the same key got in first (e.g. from another branch's account): answer as its replay.
      const replayed = isDuplicateClientKey(err) ? await replay() : null;
      if (replayed) return replayed;
      throw err;
    }
    return { transfers: transfers as unknown as TransferDocument[], batch, replayed: false };
  });
  if (created.replayed) return created;
  const { transfers, batch } = created;

  const paid = requests.flatMap((r) => (r.beneficiary ? [r.beneficiary] : []));
  if (paid.length) await BeneficiaryModel.updateMany({ _id: { $in: paid } }, { lastPaidAt: new Date() });

  if (plan.length > 0) {
    const approvers = levelApprovers(plan[0]!, await approversForBranch(business, branch._id), [userId]);
    await notifyApprovers(business, approvers, userId, transfers).catch((err) => console.error("Couldn't email approvers:", err));
  } else {
    for (const transfer of transfers) await submitTransfer(transfer);
  }
  return { transfers: await TransferModel.find({ _id: { $in: transfers.map((t) => t._id) } }).sort({ _id: 1 }), batch, replayed: false };
}

/** What's wrong with one bulk row, as in an INVALID_ROWS error's `details.rows`. */
export type RowError = { row: number; error: string; code?: string; accountName?: string };

/**
 * A dry run of createTransfers for a bulk review: each row's fee, the totals, the available balance and the
 * approval the batch would get, with everything that would stop it being sent. It creates nothing, holds no
 * money and takes no lock, so it's a prediction: sending checks it all again.
 */
export async function previewTransfers(opts: {
  business: BusinessDocument;
  membership: MembershipDocument;
  userId: string;
  branchId: string;
  rows: { amountKobo: number; narration?: string }[];
  /** The checked rows (resolvePayoutRows' check), missing where the row has an error in `errors`. */
  requests: (TransferRequest | undefined)[];
  errors: RowError[];
}) {
  const { business, membership, userId, rows, requests } = opts;
  assertMoneyCanMove(business);
  const branch = await BranchModel.findOne({ _id: opts.branchId, business: business._id });
  if (!branch || !canAccessBranch(membership, branch._id)) throw new HttpError(404, "Branch not found");
  const account = await VirtualAccountModel.findOne({ branch: branch._id });
  if (!account) throw new HttpError(409, `${branch.name}'s account isn't ready yet`, "ACCOUNT_NOT_READY");

  const errors = [...opts.errors];
  requests.forEach((r, row) => {
    if (r?.recipient.accountNumber === account.accountNumber) {
      errors.push({ row, error: "You can't send money to the account it's coming from", code: "SAME_ACCOUNT" });
    }
  });
  errors.sort((a, b) => a.row - b.row);

  const amounts = [...new Set(rows.map((r) => r.amountKobo))];
  const quotes = await inPool(amounts, 5, (amount) => quoteFee(amount));
  const fees = new Map(amounts.map((amount, i) => [amount, quotes[i]!]));
  const amountKobo = rows.reduce((s, r) => s + r.amountKobo, 0);
  const feeKobo = rows.reduce((s, r) => s + fees.get(r.amountKobo)!.feeKobo, 0);
  const stampDutyKobo = rows.reduce((s, r) => s + fees.get(r.amountKobo)!.stampDutyKobo, 0);
  const totalKobo = amountKobo + feeKobo;

  const [{ plan, earlierKobo, decidingKobo }, eligible, balance] = await Promise.all([
    planForRequest({ business, membership, userId, branchId: branch._id, amountKobo }),
    approversForBranch(business, branch._id),
    // Sending checks the balance again under the lock; an answer here is only a guide.
    availableBalance(account).catch((err) => {
      console.error("Couldn't read the balance for a bulk preview:", err);
      return null;
    }),
  ]);

  const blockers: { error: string; code?: string; details?: Record<string, unknown> }[] = [];
  try {
    await assertPlanReachable(business, branch._id, plan, userId);
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    blockers.push({ error: err.message, code: err.code, details: err.details });
  }
  if (balance && totalKobo > balance.availableKobo) {
    blockers.push({
      error: "There isn't enough money in this account for this transfer",
      code: "INSUFFICIENT_BALANCE",
      details: { availableKobo: Math.max(0, balance.availableKobo), requiredKobo: totalKobo },
    });
  }

  // Who would be asked at each level: the same people the approval emails go to (never the member themselves).
  const levels = plan.map((level) => levelApprovers(level, eligible, [userId]));
  const users = await UserModel.find({ _id: { $in: levels.flat() } }).select("name");
  const byRow = new Map(errors.map((e) => [e.row, e]));

  return {
    branch: { _id: branch.id as string, name: branch.name, isHeadOffice: !!branch.isHeadOffice },
    count: rows.length,
    amountKobo,
    feeKobo,
    stampDutyKobo,
    totalKobo,
    // null when the balance couldn't be read just now.
    availableKobo: balance ? Math.max(0, balance.availableKobo) : null,
    approval: {
      needed: plan.length > 0,
      // The amount that decided it: this batch plus what the member sent from this branch in the last 24 hours.
      decidingKobo,
      earlierKobo,
      levels: plan.map((level, i) => ({
        level: i + 1,
        // true: anyone who can approve transfers from this branch.
        any: level.any,
        approvers: levels[i]!.flatMap((id) => {
          const u = users.find((x) => x._id.equals(id));
          return u ? [{ _id: u.id as string, name: u.name }] : [];
        }),
      })),
    },
    rows: rows.map((r, row) => {
      const request = requests[row];
      const fee = fees.get(r.amountKobo)!;
      const problem = byRow.get(row);
      return {
        row,
        accountNumber: request?.recipient.accountNumber ?? null,
        // On ACCOUNT_NAME_CHANGED, the name the bank gives now.
        accountName: request?.recipient.accountName ?? problem?.accountName ?? null,
        bankName: request?.recipient.bankName ?? null,
        kind: request?.recipient.kind ?? null,
        label: request?.recipient.label ?? null,
        beneficiary: request?.beneficiary ? String(request.beneficiary) : null,
        amountKobo: r.amountKobo,
        feeKobo: fee.feeKobo,
        stampDutyKobo: fee.stampDutyKobo,
        totalKobo: r.amountKobo + fee.feeKobo,
        narration: r.narration ?? null,
        error: problem?.error ?? null,
        code: problem?.code ?? null,
      };
    }),
    // What /bulk would refuse with INVALID_ROWS (or SAME_ACCOUNT), row by row.
    errors,
    // What would stop the whole batch: NO_APPROVER or INSUFFICIENT_BALANCE.
    blockers,
    ready: errors.length === 0 && blockers.length === 0,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Approving, rejecting, cancelling
// ---------------------------------------------------------------------------------------------------------

/**
 * Approves or rejects transfers waiting for approval. An approval clears the current level: the transfer moves
 * to the next level's approvers, or, after the last level, is sent. A rejection at any level is final.
 */
export async function decideTransfers(opts: {
  transfers: TransferDocument[];
  membership: MembershipDocument;
  userId: string;
  decision: "approve" | "reject";
  note?: string;
}) {
  const { transfers, userId, decision, note } = opts;
  if (decision === "approve" && transfers[0]) {
    const owner = await BusinessModel.findById(transfers[0].business).select("compliance.status");
    if (owner) assertMoneyCanMove(owner);
  }
  for (const transfer of transfers) {
    if (!canAccessBranch(opts.membership, transfer.branch)) throw new HttpError(404, "Transfer not found");
    assertCanDecide(transfer, opts.membership, userId);
  }

  const now = new Date();
  const decided: TransferDocument[] = []; // fully approved, or rejected
  const advanced: TransferDocument[] = []; // approved at a level, waiting for the next
  for (const transfer of transfers) {
    const levels = levelsOf(transfer);
    const index = currentLevel(transfer);
    const stored = (transfer.approval?.levels?.length ?? 0) > 0;
    const mark = stored ? { [`approval.levels.${index}.approvedBy`]: userId, [`approval.levels.${index}.approvedAt`]: now, [`approval.levels.${index}.note`]: note } : {};
    const next = levels[index + 1];

    let update: Record<string, unknown>;
    if (decision === "reject") {
      update = { status: "rejected", decision: { by: userId, at: now, note }, completedAt: now, "approval.waitingOn": [], "approval.waitingOnAny": false };
    } else if (next) {
      update = { ...mark, "approval.current": index + 1, "approval.waitingOn": next.any ? [] : next.approvers, "approval.waitingOnAny": next.any };
    } else {
      update = {
        ...mark,
        status: "processing",
        decision: { by: userId, at: now, note },
        ...(stored && { "approval.current": levels.length }),
        "approval.waitingOn": [],
        "approval.waitingOnAny": false,
      };
    }
    // Conditional update, so two approvers clicking at once can't both act on the same level.
    const updated = await TransferModel.findOneAndUpdate(
      { _id: transfer._id, status: "pending_approval", ...(stored && { "approval.current": index }) },
      update,
      { returnDocument: "after" },
    );
    if (updated) (decision === "approve" && next ? advanced : decided).push(updated);
  }

  if (decided.length) {
    const [business, decider] = await Promise.all([
      BusinessModel.findById(decided[0]!.business).select("name"),
      UserModel.findById(userId).select("name"),
    ]);
    if (business) await transfersDecided(business, decided, decision, decider?.name ?? "A team member", note);
  }
  if (advanced.length) await notifyNextLevel(advanced, userId).catch((err) => console.error("Couldn't tell the next approvers:", err));
  if (decision === "approve") {
    for (const transfer of decided) await submitTransfer(transfer);
  } else if (decided.length) {
    await notifyRejected(decided, note).catch((err) => console.error("Couldn't email the rejection:", err));
  }
  return [...decided, ...advanced];
}

/** The rows of a batch this member can decide now, and their total before fees: "Approve N (₦X)". */
export function awaitingMember(transfers: TransferDocument[], membership: MembershipDocument, userId: string) {
  const rows = transfers.filter((t) => canDecide(t, membership, userId));
  return { rows, count: rows.length, amountKobo: rows.reduce((s, t) => s + t.amountKobo, 0) };
}

/**
 * Approves or rejects the rows of a batch that are waiting for this member (see `canDecide`) and leaves the
 * others as they are, so a batch partly approved one row at a time, or with rows at different levels, can
 * still be finished as a batch. `skipped` counts the rows that were waiting but not decided here, including
 * any someone else decided at the same moment.
 *
 * `expect` (required) binds the decision to what the member was shown: the count and total (`awaitingMe`,
 * `awaitingMeKobo`) of the rows they could decide then. If the rows they can decide now (in `transfers`, read
 * for this request) aren't exactly that, it's refused with 409 BATCH_CHANGED (`details`: the count and total
 * now) and nothing is decided. Otherwise exactly those rows, by id, are decided, each with a write conditional
 * on it still being at the level read (decideTransfers). A row that reaches the member's level after the read
 * isn't among them, and one someone else decides first is skipped, so the decision never covers more rows or
 * money than the member confirmed, only less.
 */
export async function decideBatchTransfers(opts: {
  transfers: TransferDocument[];
  membership: MembershipDocument;
  userId: string;
  decision: "approve" | "reject";
  note?: string;
  expect: { count: number; amountKobo: number };
}) {
  const { transfers, membership, userId, decision, note, expect } = opts;
  const pending = transfers.filter((t) => t.status === "pending_approval");
  if (!pending.length) throw new HttpError(409, "Nothing in this batch is waiting for approval", "TRANSFER_NOT_PENDING");
  const mine = awaitingMember(pending, membership, userId);
  if (!mine.count) {
    // A batch has one creator, so its creator can never decide any of it.
    if (pending.every((t) => t.createdBy.equals(userId))) {
      throw new HttpError(403, "Someone else has to approve a transfer you created", "CANNOT_APPROVE_OWN");
    }
    throw new HttpError(409, "Nothing in this batch is waiting for your approval", "NOTHING_TO_DECIDE", { pending: pending.length });
  }
  if (mine.count !== expect.count || mine.amountKobo !== expect.amountKobo) {
    throw new HttpError(409, "This bulk transfer has changed since you opened it. Check what's waiting for you now.", "BATCH_CHANGED", {
      count: mine.count,
      amountKobo: mine.amountKobo,
    });
  }
  // decideTransfers updates each row only if it's still at the level read here, and returns those it changed.
  const changed = await decideTransfers({ transfers: mine.rows, membership, userId, decision, note });
  return { decided: changed.length, skipped: pending.length - changed.length };
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
  err instanceof LiquifiaError &&
  err.status >= 400 &&
  err.status < 500 &&
  ![408, 409, 425, 429].includes(err.status) &&
  // An answer about a repeated key or reference means an earlier request may have created it.
  !/IDEMPOTEN|DUPLICATE|IN_PROGRESS/i.test(err.code);

function failureMessage(err: unknown) {
  if (err instanceof LiquifiaError && err.code === "INSUFFICIENT_BALANCE") return "There wasn't enough money in the account";
  if (err instanceof LiquifiaError) return err.message;
  return "The transfer couldn't be completed";
}

/**
 * How long a caller has to send a transfer before another may try: up to five Liquifia calls (look up, create,
 * look up again) at 30 s each, with room to spare. A caller that dies holding it only delays the retry.
 */
const SUBMIT_LEASE_MS = 5 * 60_000;
// Staff hear about a transfer Liquifia hasn't accepted an hour after the first try (well inside the 24 hours
// Liquifia keeps idempotency keys), and about one it accepted that hasn't settled in a day.
const STUCK_UNSENT_MS = 60 * 60_000;
const STUCK_UNSETTLED_MS = 24 * 60 * 60_000;

const leaseFree = (now: Date) => ({ $or: [{ "provider.submittingUntil": null }, { "provider.submittingUntil": { $lte: now } }] });
const reload = async (transfer: TransferDocument) => (await TransferModel.findById(transfer._id)) ?? transfer;

/**
 * Hands an approved transfer to Liquifia. Safe to call from several places at once (the create request, approvals,
 * the sweep, webhooks, /refresh): the caller that claims the transfer sends it, the others return it as it is.
 * Every attempt carries the same idempotency key, and a retry looks the payout up first, so a retry after a
 * timeout finds the payout already created instead of paying twice.
 */
export async function submitTransfer(transfer: TransferDocument) {
  if (transfer.status !== "processing" || transfer.provider?.payoutId) return transfer;
  // A suspended or closed business's approved transfers are held, not sent, until it's reinstated.
  const owner = await BusinessModel.findById(transfer.business).select("compliance.status");
  const restriction = owner?.compliance?.status;
  if (restriction === "suspended" || restriction === "banned") {
    await TransferModel.updateOne(
      { _id: transfer._id, status: "processing" },
      { "provider.lastCheckedAt": new Date(), "provider.lastError": `Held: the business is ${restriction}` },
    );
    return reload(transfer);
  }
  const account = await VirtualAccountModel.findById(transfer.virtualAccount);
  if (!account) throw new Error(`Virtual account ${transfer.virtualAccount} not found`);

  // Claim it first. The lease time doubles as the claim's token, so only this caller can fail or release it.
  const now = new Date();
  const lease = new Date(now.getTime() + SUBMIT_LEASE_MS);
  const claimed = await TransferModel.findOneAndUpdate(
    { _id: transfer._id, status: "processing", "provider.payoutId": { $exists: false }, ...leaseFree(now) },
    {
      $set: { "provider.submittingUntil": lease, "provider.lastCheckedAt": now },
      $inc: { "provider.attempts": 1 },
      $min: { "provider.firstAttemptAt": now },
    },
    { returnDocument: "after" },
  );
  if (!claimed) return reload(transfer);

  const outcome = await sendPayout(claimed, account.providerAccountId);
  if ("payout" in outcome) return adoptPayout(claimed, outcome.payout);
  if ("rejected" in outcome) return failSubmission(claimed, lease, outcome.rejected);
  // Unknown outcome: keep holding the money and retry later (processOpenTransfers), looking it up first.
  const message = outcome.unknown instanceof Error ? outcome.unknown.message : String(outcome.unknown);
  await TransferModel.updateOne(
    { _id: claimed._id, "provider.submittingUntil": lease },
    { $set: { "provider.lastError": message }, $unset: { "provider.submittingUntil": 1 } },
  );
  console.error(`Payout for transfer ${claimed.id} didn't go through yet:`, outcome.unknown);
  return reload(claimed);
}

type SendOutcome = { payout: LiquifiaPayout } | { rejected: unknown } | { unknown: unknown };

/** One attempt at getting the payout created. Only the first attempt's refusal means it wasn't. */
async function sendPayout(transfer: TransferDocument, virtualAccountId: string): Promise<SendOutcome> {
  // From the second attempt on, an earlier one may have created the payout: look before sending again
  // (Liquifia keeps idempotency keys for 24 hours only).
  const retry = (transfer.provider?.attempts ?? 1) > 1;
  if (retry) {
    try {
      const existing = await liquifia.findPayoutByReference(transfer.reference);
      if (existing) return { payout: existing };
    } catch (err) {
      return { unknown: err };
    }
  }
  try {
    const payout = await liquifia.createPayout(
      {
        virtual_account_id: virtualAccountId,
        amount: toNaira(transfer.amountKobo),
        destination_account: transfer.recipient!.accountNumber,
        destination_bank_uuid: transfer.recipient!.bankUuid,
        reference: transfer.reference,
        narration: transfer.narration ?? undefined,
      },
      transfer.provider!.idempotencyKey,
    );
    return { payout };
  } catch (err) {
    if (!isDefinitiveRejection(err)) return { unknown: err };
    if (!retry) return { rejected: err };
    // A retry refused with a 4xx may only mean an earlier attempt got there: it failed only if there's no payout.
    try {
      const existing = await liquifia.findPayoutByReference(transfer.reference);
      return existing ? { payout: existing } : { rejected: err };
    } catch (lookupErr) {
      return { unknown: lookupErr };
    }
  }
}

/** Saves the payout Liquifia has for this transfer (unless another caller already did), then follows its status. */
async function adoptPayout(transfer: TransferDocument, payout: LiquifiaPayout) {
  const saved = await TransferModel.findOneAndUpdate(
    { _id: transfer._id, status: "processing", "provider.payoutId": { $exists: false } },
    {
      $set: {
        "provider.payoutId": payout.id,
        "provider.status": payout.status,
        "provider.data": payout,
        submittedAt: transfer.submittedAt ?? new Date(),
      },
      $unset: { "provider.lastError": 1, "provider.submittingUntil": 1 },
    },
    { returnDocument: "after" },
  );
  if (!saved) {
    const current = await reload(transfer);
    if (current.provider?.payoutId !== payout.id) {
      const ours = current.provider?.payoutId ?? "none";
      console.error(`Liquifia has payout ${payout.id} for transfer ${transfer.id}, which is ${current.status} with payout ${ours}`);
    }
    return current;
  }
  return applyPayoutStatus(saved, payout.status, payout);
}

/** Fails a transfer Liquifia refused, while this caller still holds the claim (so a later attempt can't be overwritten). */
async function failSubmission(transfer: TransferDocument, lease: Date, err: unknown) {
  const now = new Date();
  const failed = await TransferModel.findOneAndUpdate(
    { _id: transfer._id, status: "processing", "provider.payoutId": { $exists: false }, "provider.submittingUntil": lease },
    {
      $set: { status: "failed", failureReason: failureMessage(err), completedAt: now, "provider.lastError": String(err), "provider.lastCheckedAt": now },
      $unset: { "provider.submittingUntil": 1 },
    },
    { returnDocument: "after" },
  );
  if (!failed) return reload(transfer);
  await notifyFailed(failed).catch((e) => console.error("Couldn't email the failure:", e));
  return failed;
}

/**
 * The debit on the source account, shown with the business's transactions. Created if it's missing, so any
 * refresh repairs a crash between saving the payout id and writing this. Its status only moves on from pending.
 */
async function recordPayoutTransaction(transfer: TransferDocument) {
  const status = mapTransactionStatus(transfer.status);
  await TransactionModel.updateOne(
    { providerTransactionId: transfer.provider!.payoutId },
    {
      $setOnInsert: {
        status,
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
  // Conditional, so a caller that read the transfer before it settled can't move the row back to pending.
  if (status !== "pending") await TransactionModel.updateOne({ providerTransactionId: transfer.provider!.payoutId, status: "pending" }, { status });
}

const mapTransactionStatus = (status: string) => (status === "success" ? "success" : status === "failed" ? "failed" : "pending");

/** Moves the transfer to success or failed when Liquifia says so, and keeps its debit row in step. */
async function applyPayoutStatus(transfer: TransferDocument, providerStatus: string, data?: unknown) {
  const status = providerStatus?.toLowerCase();
  const now = new Date();
  const seen = { "provider.status": status, "provider.lastCheckedAt": now, ...(data !== undefined && { "provider.data": data }) };
  // Conditional on still processing, so only one caller settles it (and tells people), and a final status stays.
  const settled =
    status === "success" || status === "failed"
      ? await TransferModel.findOneAndUpdate(
          { _id: transfer._id, status: "processing" },
          {
            ...seen,
            status,
            completedAt: now,
            ...(status === "failed" && { failureReason: transfer.failureReason ?? "The bank couldn't complete the transfer" }),
          },
          { returnDocument: "after" },
        )
      : null;
  if (!settled) await TransferModel.updateOne({ _id: transfer._id, status: "processing" }, seen);
  const current = settled ?? (await reload(transfer));
  if (current.provider?.payoutId) await recordPayoutTransaction(current);
  if (settled?.status === "failed") await notifyFailed(settled).catch((e) => console.error("Couldn't email the failure:", e));
  if (settled?.status === "success") await transferSettled(settled);
  // Liquifia documents only these four. Anything else (a reversal, say) is for a person to judge, not a guess.
  if (current.status === "processing" && status && !(PAYOUT_STATUSES as readonly string[]).includes(status)) {
    await flagStuck(current, `is "${status}" at Liquifia, a status LinkPay doesn't know`);
  }
  return current;
}

/** Tells staff about a transfer that needs a person, once per transfer, and logs it. */
async function flagStuck(transfer: TransferDocument, reason: string) {
  const flagged = await TransferModel.findOneAndUpdate(
    { _id: transfer._id, status: "processing", "provider.stuckAt": { $exists: false } },
    { "provider.stuckAt": new Date() },
    { returnDocument: "after" },
  );
  if (!flagged) return;
  console.error(`Transfer ${transfer.id} (${transfer.reference}) ${reason}.`);
  await transferStuck(flagged, reason).catch((err) => console.error("Couldn't tell staff about a stuck transfer:", err));
}

/** Flags a transfer still processing too long: not accepted an hour after the first try, or not settled after a day. */
async function flagIfStuck(transfer: TransferDocument) {
  if (transfer.status !== "processing" || transfer.provider?.stuckAt) return;
  const accepted = !!transfer.provider?.payoutId;
  const since = accepted ? (transfer.submittedAt ?? transfer.provider?.firstAttemptAt) : transfer.provider?.firstAttemptAt;
  // Never tried: held for a suspended business, or not reached yet.
  if (!since || Date.now() - since.getTime() < (accepted ? STUCK_UNSETTLED_MS : STUCK_UNSENT_MS)) return;
  await flagStuck(transfer, accepted ? "hasn't settled a day after it was sent" : "hasn't been accepted by Liquifia an hour after the first try");
}

/** Asks Liquifia for the latest on one transfer (or sends it again if Liquifia never accepted it). */
export async function refreshTransfer(transfer: TransferDocument) {
  if (transfer.status !== "processing") return transfer;
  if (!transfer.provider?.payoutId) return submitTransfer(transfer);
  const payout = await liquifia.getPayout(transfer.provider.payoutId);
  return applyPayoutStatus(transfer, payout.status, payout);
}

/**
 * A payout webhook. The payload only picks which transfer to refresh (our reference or Liquifia's payout id); its
 * status and amounts aren't trusted. When it names no transfer we know, the usual follow-up runs instead.
 */
export async function refreshFromPayoutEvent(payload: unknown) {
  const body = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const data = body.data && typeof body.data === "object" ? (body.data as Record<string, unknown>) : body;
  const ids = [data.reference, data.payout_reference, data.id, data.payout_id].filter(
    (v): v is string => typeof v === "string" && v.length > 0 && v.length <= 100,
  );
  const transfer = ids.length ? await TransferModel.findOne({ $or: [{ reference: { $in: ids } }, { "provider.payoutId": { $in: ids } }] }) : null;
  return transfer ? refreshTransfer(transfer) : followUpOpenTransfers();
}

/** Follows up every transfer still in progress, except any another caller is sending right now. */
export async function processOpenTransfers({ minAgeMs = 0 } = {}) {
  const now = new Date();
  const stale = new Date(now.getTime() - minAgeMs);
  const open = await TransferModel.find({
    status: "processing",
    $and: [{ $or: [{ "provider.lastCheckedAt": { $exists: false } }, { "provider.lastCheckedAt": { $lte: stale } }] }, leaseFree(now)],
  })
    .sort({ "provider.lastCheckedAt": 1 })
    .limit(200);
  const counts = { checked: 0, success: 0, failed: 0, errors: 0 };
  for (const transfer of open) {
    let after = transfer;
    try {
      after = await refreshTransfer(transfer);
      counts.checked++;
      if (after.status === "success") counts.success++;
      if (after.status === "failed") counts.failed++;
    } catch (err) {
      counts.errors++;
      await TransferModel.updateOne({ _id: transfer._id }, { "provider.lastCheckedAt": new Date(), "provider.lastError": String(err) });
      console.error(`Couldn't check transfer ${transfer.id}:`, err);
    }
    await flagIfStuck(after).catch((err) => console.error(`Couldn't flag transfer ${transfer.id}:`, err));
  }
  return counts;
}

let running: Promise<unknown> | null = null;

/** Runs processOpenTransfers unless a run is already going, in which case it returns that run. */
export function followUpOpenTransfers(minAgeMs = 0) {
  running ??= processOpenTransfers({ minAgeMs })
    .catch((err) => console.error("Transfer follow-up failed:", err))
    .finally(() => {
      running = null;
    });
  return running;
}

/** Starts following up open transfers in the background (not used in tests). */
export function startTransferProcessor(intervalMs: number) {
  if (intervalMs <= 0) return () => {};
  const tick = () => {
    if (!running) void followUpOpenTransfers(intervalMs / 2);
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
  approverIds: Types.ObjectId[],
  creatorId: Types.ObjectId | string,
  transfers: TransferDocument[],
  progress?: string,
) {
  const batchId = transfers[0]!.batch ? String(transfers[0]!.batch) : undefined;
  const [creator, approvers] = await Promise.all([
    UserModel.findById(creatorId).select("name"),
    UserModel.find({ _id: { $in: approverIds } }).select("email"),
  ]);
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
  await transferApprovalRequested(business, approverIds, creator?.name ?? "A team member", transfers, progress);
}

/** After a level is approved: tells the next level's approvers, one message per batch or transfer. */
async function notifyNextLevel(transfers: TransferDocument[], approvedBy: string) {
  const groups = new Map<string, TransferDocument[]>();
  for (const t of transfers) {
    const key = t.batch ? `b${t.batch}` : `t${t.id}`;
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  const approver = await UserModel.findById(approvedBy).select("name");
  for (const group of groups.values()) {
    const first = group[0]!;
    const business = await BusinessModel.findById(first.business);
    if (!business) continue;
    const levels = levelsOf(first);
    const index = currentLevel(first);
    const earlier = levels.slice(0, index).map((l) => l.approvedBy).filter((id): id is Types.ObjectId => !!id);
    const ids = levelApprovers(levels[index]! as PlannedLevel, await approversForBranch(business, first.branch), [first.createdBy, ...earlier]);
    const progress = `${approver?.name ?? "A team member"} approved level ${index} of ${levels.length}.`;
    await notifyApprovers(business, ids, first.createdBy, group, progress);
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
  if (creator) {
    await sendTransferFailedEmail(creator.email, {
      amountKobo: transfer.amountKobo,
      recipientName: transfer.recipient!.accountName,
      reason: transfer.failureReason ?? undefined,
    });
  }
  await transferSettled(transfer);
}
