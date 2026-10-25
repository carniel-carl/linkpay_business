import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useBusinessContext } from "@/lib/business-context";
import { formatNaira } from "@/lib/format";
import { api, BULK_MONEY_TIMEOUT_MS, MONEY_TIMEOUT_MS } from "./client";
import { idSegment } from "./paths";
import { pinHeader } from "./transaction-pin";
import { ApiError } from "./errors";
import type {
  ApprovalRule,
  ApprovalTier,
  Bank,
  BatchExpectation,
  BatchLevel,
  BulkPreview,
  BulkRequest,
  BulkResult,
  BulkRowError,
  FeeQuote,
  ResolvedAccount,
  ResolvedRow,
  Transfer,
  TransferBatch,
  TransferBatchDecision,
  TransferBatchList,
  TransferList,
  TransferStatus,
} from "./types";

// /api/transfers. Copy (status and kind labels) matches the web's Transfers page.

const useBusinessKey = () => useBusinessContext((s) => s.businessId ?? "default");

export const STATUS_LABELS: Record<TransferStatus, string> = {
  pending_approval: "Awaiting approval",
  processing: "In progress",
  success: "Sent",
  failed: "Failed",
  rejected: "Rejected",
  cancelled: "Cancelled",
};

export const KIND_LABELS = { bank: "Bank transfer", internal: "Between branches", linkpay: "To a LinkPay business" } as const;

/** The list's tabs, as on the web. `awaiting` is "Needs your approval". */
export const TRANSFER_TABS = [
  { key: "all", label: "All" },
  { key: "awaiting", label: "Needs your approval" },
  { key: "pending_approval", label: "Waiting for approval" },
  { key: "processing", label: "In progress" },
  { key: "success", label: "Completed" },
  { key: "failed", label: "Failed" },
] as const;
export type TransferTab = (typeof TRANSFER_TABS)[number]["key"];

/**
 * `q` searches the recipient, reference and narration. `singles` leaves out the transfers that are part of a bulk
 * transfer (`batch=none`), for a list that shows each bulk transfer as one row from the batch list.
 */
export function useTransfers(
  tab: TransferTab,
  { enabled = true, q, singles = false }: { enabled?: boolean; q?: string; singles?: boolean } = {},
) {
  const business = useBusinessKey();
  return useInfiniteQuery({
    queryKey: [business, "transfers", tab, q, singles],
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams({ skip: String(pageParam), take: "30" });
      if (tab === "awaiting") params.set("awaiting", "me");
      else if (tab !== "all") params.set("status", tab);
      if (q) params.set("q", q);
      if (singles) params.set("batch", "none");
      return api<TransferList>(`/api/transfers?${params}`, { signal });
    },
    initialPageParam: 0,
    getNextPageParam: (last) => (last.skip + last.items.length < last.total ? last.skip + last.items.length : undefined),
    placeholderData: keepPreviousData,
    enabled,
  });
}

/** How many transfers wait for the signed-in member's approval (Home's banner). */
export function useAwaitingCount(enabled: boolean) {
  const business = useBusinessKey();
  return useQuery({
    queryKey: [business, "transfers", "awaiting-count"],
    queryFn: () => api<TransferList>("/api/transfers?awaiting=me&take=1"),
    select: (d) => d.total,
    enabled,
    refetchInterval: 60_000,
  });
}

/** Fund approvals tabs, as on the web (`approval=pending|approved|rejected`). */
export const APPROVAL_TABS = [
  { key: "pending", label: "Pending" },
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Declined" },
] as const;
export type ApprovalTab = (typeof APPROVAL_TABS)[number]["key"];

/**
 * Transfers that went through approval: waiting at any level, approved and sent, or declined. `singles` leaves
 * out bulk transfers' rows, as useTransfers.
 */
export function useApprovals(tab: ApprovalTab, { q, singles = false }: { q?: string; singles?: boolean } = {}) {
  const business = useBusinessKey();
  return useInfiniteQuery({
    queryKey: [business, "transfers", "approvals", tab, q, singles],
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams({ approval: tab, skip: String(pageParam), take: "30" });
      if (q) params.set("q", q);
      if (singles) params.set("batch", "none");
      return api<TransferList>(`/api/transfers?${params}`, { signal });
    },
    initialPageParam: 0,
    getNextPageParam: (last) => (last.skip + last.items.length < last.total ? last.skip + last.items.length : undefined),
    placeholderData: keepPreviousData,
  });
}

/** How many transfers wait for approval at any level ("Total pending"). */
export function usePendingApprovalCount(enabled = true) {
  const business = useBusinessKey();
  return useQuery({
    queryKey: [business, "transfers", "pending-count"],
    queryFn: () => api<TransferList>("/api/transfers?approval=pending&take=1"),
    select: (d) => d.total,
    enabled,
    refetchInterval: 60_000,
  });
}

/** Where a transfer stands in its approvals: "Level 1 of 2, waiting for Ada", "Approved by Bola". Copy from the web. */
export function approvalProgress(t: Transfer) {
  const levels = t.approval?.levels ?? [];
  if (t.status === "pending_approval") {
    const level = levels.find((l) => l.status === "waiting");
    const who = !level || level.any || !level.approvers.length ? "any approver" : level.approvers.map((a) => a.name).join(", ");
    return levels.length > 1 ? `Level ${level?.level ?? 1} of ${levels.length}, waiting for ${who}` : `Waiting for ${who}`;
  }
  const by = t.decision?.by?.name;
  if (t.status === "rejected") return by ? `Declined by ${by}` : "Declined";
  if (t.status === "cancelled") return "Cancelled before approval";
  if (levels.length > 1) return `All ${levels.length} levels approved`;
  return by ? `Approved by ${by}` : "Approved";
}

/** "₦100,000 to ₦999,999.99", or "₦1,000,000 and above" for the top band. Copy from the web. */
export function tierRange(tiers: Pick<ApprovalTier, "minKobo">[], index: number) {
  const from = tiers[index].minKobo;
  const next = tiers[index + 1]?.minKobo;
  if (next === undefined) return from === 0 ? "Every transfer" : `${formatNaira(from)} and above`;
  return `${from === 0 ? "Up to" : `${formatNaira(from)} to`} ${formatNaira(next - 1)}`;
}

export function useTransfer(id: string) {
  const business = useBusinessKey();
  return useQuery({
    queryKey: [business, "transfer", id],
    queryFn: () => api<Transfer>(`/api/transfers/${idSegment(id)}`),
    // In progress: check again every 10 s until it settles.
    refetchInterval: (q) => (q.state.data?.status === "processing" ? 10_000 : false),
  });
}

/** After a transfer changes: the answer replaces the cached transfer, and money and lists refresh for the business. */
export function useTransferChanged() {
  const qc = useQueryClient();
  const business = useBusinessKey();
  return (t: Transfer) => {
    qc.setQueryData([business, "transfer", t._id], t);
    void qc.invalidateQueries({ queryKey: [business] });
  };
}

/** Reject, cancel or refresh: none of them moves money, so none needs the transaction PIN. Approving is approveTransfer. */
export function useTransferAction() {
  const changed = useTransferChanged();
  return useMutation({
    mutationFn: ({ id, action, note }: { id: string; action: "reject" | "cancel" | "refresh"; note?: string }) =>
      api<Transfer>(`/api/transfers/${idSegment(id)}/${action}`, {
        method: "POST",
        json: action === "reject" ? { note: note || undefined } : {},
        timeoutMs: MONEY_TIMEOUT_MS,
      }),
    onSuccess: changed,
  });
}

/**
 * Approves one level of a transfer; the last level sends the payout in the same request. A plain call rather
 * than a mutation, so the PIN stays out of react-query's state: it's only this request's header.
 */
export const approveTransfer = (id: string, note: string | undefined, pin: string) =>
  api<Transfer>(`/api/transfers/${idSegment(id)}/approve`, {
    method: "POST",
    json: { note: note || undefined },
    headers: pinHeader(pin),
    timeoutMs: MONEY_TIMEOUT_MS,
  });

export function useBanks(enabled = true) {
  const business = useBusinessKey();
  return useQuery({ queryKey: [business, "banks"], queryFn: () => api<Bank[]>("/api/transfers/banks"), staleTime: 60 * 60_000, enabled });
}

/** Name enquiry with the recipient's bank, once the number is 10 digits. */
export function useResolveAccount(accountNumber: string, bankUuid?: string) {
  const business = useBusinessKey();
  const ready = /^\d{10}$/.test(accountNumber) && !!bankUuid;
  return useQuery({
    queryKey: [business, "resolve", bankUuid, accountNumber],
    queryFn: () => api<ResolvedAccount>("/api/transfers/resolve-account", { method: "POST", json: { accountNumber, bankUuid } }),
    enabled: ready,
    retry: false,
    staleTime: 10 * 60_000,
  });
}

/** With `branch`, whether approval is needed counts what this member sent from it in the last 24 hours, as sending does. */
export function useFee(amountKobo: number | undefined, branch?: string) {
  const business = useBusinessKey();
  return useQuery({
    queryKey: [business, "fee", amountKobo, branch ?? null],
    queryFn: () => api<FeeQuote>(`/api/transfers/fee?amountKobo=${amountKobo}${branch ? `&branch=${idSegment(branch)}` : ""}`),
    enabled: !!amountKobo && amountKobo >= 100,
    staleTime: 5 * 60_000,
  });
}

export type SendRequest = {
  branch: string;
  amountKobo: number;
  narration?: string;
  recipient: { type: "bank"; accountNumber: string; bankUuid: string } | { type: "branch"; branch: string };
};

/**
 * Creates one transfer. The Idempotency-Key makes a retried send (dropped connection) return the same transfer.
 * The PIN is a header, not part of the body, so retrying with a corrected PIN keeps the same key.
 */
export const sendTransfer = (body: SendRequest, idempotencyKey: string, pin: string) =>
  api<Transfer>("/api/transfers", {
    method: "POST",
    json: body,
    headers: { "Idempotency-Key": idempotencyKey, ...pinHeader(pin) },
    timeoutMs: MONEY_TIMEOUT_MS,
  });

// ---- Bulk transfers (docs/briefs/bulk-payouts.md) ----

/**
 * Accounts per resolve-accounts call in a bulk review. The API asks the banks five at a time and allows 60 calls
 * per member in 15 minutes; slices of 25 keep each call short on a phone and the progress moving, and a full
 * 200-row check is 8 calls.
 */
export const BULK_CHECK_SLICE = 25;

/** Name checks and the preview can wait on the banks for every row they ask about, so they get longer than a plain read. */
const BULK_REVIEW_TIMEOUT_MS = 60_000;

/** Name enquiries for a bulk review, no PIN: one answer per row, in order. Moves no money. */
export const resolveAccounts = (items: { accountNumber: string; bankUuid: string }[], signal?: AbortSignal) =>
  api<{ items: ResolvedRow[]; resolved: number; failed: number }>("/api/transfers/resolve-accounts", {
    method: "POST",
    json: { items },
    timeoutMs: BULK_REVIEW_TIMEOUT_MS,
    signal,
  });

/** A dry run of a bulk transfer: each row's fee and problem, the totals, the balance and who would approve. No PIN. */
export const previewBulkTransfer = (body: BulkRequest, signal?: AbortSignal) =>
  api<BulkPreview>("/api/transfers/bulk/preview", { method: "POST", json: body, timeoutMs: BULK_REVIEW_TIMEOUT_MS, signal });

/**
 * Sends a bulk transfer. As with one transfer, the PIN is this request's header only, and the Idempotency-Key
 * comes from the rows (without the names the member reviewed, as the API's request hash leaves them out), so
 * sending the same rows again after a lost answer, a wrong PIN or a re-checked name returns the first batch. It
 * waits longer than the preview: the server checks every row with its bank again first.
 */
export const sendBulkTransfer = (body: BulkRequest, idempotencyKey: string, pin: string) =>
  api<BulkResult>("/api/transfers/bulk", {
    method: "POST",
    json: body,
    headers: { "Idempotency-Key": idempotencyKey, ...pinHeader(pin) },
    timeoutMs: BULK_MONEY_TIMEOUT_MS,
  });

/** The rows an INVALID_ROWS refusal names (`details.rows`); nothing was created. */
export function invalidRowsOf(err: unknown): BulkRowError[] {
  if (!(err instanceof ApiError) || err.code !== "INVALID_ROWS") return [];
  const rows = (err.details as { rows?: unknown } | undefined)?.rows;
  return Array.isArray(rows) ? rows.filter((r): r is BulkRowError => typeof r?.row === "number" && typeof r?.error === "string") : [];
}

/** A bulk transfer and every transfer in it. Checks again every 10 s while any is in progress. */
export function useTransferBatch(id: string) {
  const business = useBusinessKey();
  return useQuery({
    queryKey: [business, "batch", id],
    queryFn: () => api<TransferBatch>(`/api/transfers/batches/${idSegment(id)}`),
    refetchInterval: (q) => (q.state.data?.items.some((t) => t.status === "processing") ? 10_000 : false),
  });
}

/** Which bulk transfers a list shows: a Fund approvals tab, or "Needs your approval" (`awaiting`). */
export type BatchScope = ApprovalTab | "awaiting";

/**
 * Bulk transfers, newest first, each with its counts and where its waiting transfers are, without their rows
 * (GET batches). Under "transfers", so whatever refreshes the transfer lists refreshes these too.
 */
export function useTransferBatches(scope: BatchScope, enabled = true) {
  const business = useBusinessKey();
  return useInfiniteQuery({
    queryKey: [business, "transfers", "batches", scope],
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams({ skip: String(pageParam), take: "30" });
      if (scope === "awaiting") params.set("awaiting", "me");
      else params.set("approval", scope);
      return api<TransferBatchList>(`/api/transfers/batches?${params}`, { signal });
    },
    initialPageParam: 0,
    getNextPageParam: (last) => (last.skip + last.items.length < last.total ? last.skip + last.items.length : undefined),
    placeholderData: keepPreviousData,
    enabled,
  });
}

/** A batch's waiting transfers by their current level, lowest first, as GET batches gives them (`levels`). */
export function waitingLevels(items: Transfer[]): BatchLevel[] {
  const at = new Map<string, BatchLevel>();
  for (const t of items) {
    if (t.status !== "pending_approval") continue;
    const level = t.approval?.current ?? 1;
    const of = Math.max(t.approval?.levels.length ?? 0, 1);
    const entry = at.get(`${level}/${of}`) ?? { level, of, waiting: 0, awaitingMe: 0 };
    entry.waiting += 1;
    if (t.canApprove) entry.awaitingMe += 1;
    at.set(`${level}/${of}`, entry);
  }
  return [...at.values()].sort((x, y) => x.level - y.level || x.of - y.of);
}

/**
 * Where a batch's waiting transfers are: "Level 1 of 2 · 3 waiting for you", "Levels 1 to 2 of 2 · 5 waiting,
 * 2 for you", or "3 waiting" with one level. Empty when nothing waits.
 */
export function batchLevelLine(levels: BatchLevel[]) {
  if (!levels.length) return "";
  const of = Math.max(...levels.map((l) => l.of));
  const low = Math.min(...levels.map((l) => l.level));
  const high = Math.max(...levels.map((l) => l.level));
  const waiting = levels.reduce((s, l) => s + l.waiting, 0);
  const mine = levels.reduce((s, l) => s + l.awaitingMe, 0);
  const where = of <= 1 ? "" : low === high ? `Level ${low} of ${of}` : `Levels ${low} to ${high} of ${of}`;
  // No-break spaces keep "2 for you" together when the line wraps.
  const who = mine === 0 ? `${waiting} waiting` : mine === waiting ? `${mine} waiting for you` : `${waiting} waiting, ${mine}\u00a0for\u00a0you`;
  return [where, who].filter(Boolean).join(" · ");
}

/** After a batch changes: the answer replaces the cached batch and its transfers, and money and lists refresh. */
export function useBatchChanged() {
  const qc = useQueryClient();
  const business = useBusinessKey();
  return (b: TransferBatch) => {
    qc.setQueryData([business, "batch", b._id], b);
    for (const t of b.items) qc.setQueryData([business, "transfer", t._id], t);
    void qc.invalidateQueries({ queryKey: [business] });
  };
}

/**
 * Reject the transfers in a batch waiting for the member (and leave the rest for their approvers), or, for its
 * creator, cancel everything still waiting. Neither moves money, so neither needs the PIN. Rejecting sends what the
 * member was shown (`expect`), so it can't reject more than that, and answers with `decided` and `skipped` too.
 */
export function useBatchAction() {
  const changed = useBatchChanged();
  return useMutation({
    mutationFn: ({ id, action, note, expect }: { id: string; action: "reject" | "cancel"; note?: string; expect?: BatchExpectation }) =>
      api<TransferBatch & Partial<Pick<TransferBatchDecision, "decided" | "skipped">>>(`/api/transfers/batches/${idSegment(id)}/${action}`, {
        method: "POST",
        json: action === "reject" ? { note: note || undefined, expect } : {},
        timeoutMs: MONEY_TIMEOUT_MS,
      }),
    onSuccess: changed,
  });
}

/**
 * Approves the current level of the transfers in a batch waiting for the member, and leaves the rest for their
 * approvers; a last level sends those payouts. `expect` is the count and total the member was shown: if what
 * waits for them has changed since, nothing is approved (BATCH_CHANGED). A plain call, not a mutation, so the PIN
 * stays out of react-query's state.
 */
export const approveBatch = (id: string, note: string | undefined, expect: BatchExpectation, pin: string) =>
  api<TransferBatchDecision>(`/api/transfers/batches/${idSegment(id)}/approve`, {
    method: "POST",
    json: { note: note || undefined, expect },
    headers: pinHeader(pin),
    timeoutMs: MONEY_TIMEOUT_MS,
  });

/** What waits for the member now, from a BATCH_CHANGED refusal's `details`. */
export function batchChangedOf(err: unknown): BatchExpectation | undefined {
  if (!(err instanceof ApiError) || err.code !== "BATCH_CHANGED") return undefined;
  const d = err.details as Partial<BatchExpectation> | undefined;
  return typeof d?.count === "number" && typeof d.amountKobo === "number" ? { count: d.count, amountKobo: d.amountKobo } : undefined;
}

/** "Ada, Bola or Chidi". */
const joinOr = (names: string[]) => (names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`);

/** A preview's approval as one line, as on the web: "Needs approval from Ada or Bola, then Chidi", or "Sends straight away". */
export function approvalLine(approval: BulkPreview["approval"]) {
  if (!approval.needed) return "Sends straight away";
  const level = (l: BulkPreview["approval"]["levels"][number]) => {
    if (!l.approvers.length) return "someone who can approve transfers";
    if (l.any && l.approvers.length > 3) return "anyone who can approve transfers";
    const names = l.approvers.map((a) => a.name);
    return names.length > 3 ? `${names.slice(0, 2).join(", ")} or ${names.length - 2} others` : joinOr(names);
  };
  return `Needs approval from ${approval.levels.map(level).join(", then ")}`;
}

export function useApprovalRule(enabled = true) {
  const business = useBusinessKey();
  return useQuery({
    queryKey: [business, "transfers", "settings"],
    queryFn: () => api<{ approval: ApprovalRule }>("/api/transfers/settings"),
    select: (d) => d.approval,
    enabled,
  });
}

/** One line describing the rule, as on the web. */
export function describeApprovalRule(rule: ApprovalRule) {
  if (rule.mode === "workflow" && rule.tiers?.length) {
    const lowest = rule.tiers[0];
    const most = Math.max(...rule.tiers.map((t) => t.levels.length));
    const from = lowest.minKobo > 0 ? `from ${formatNaira(lowest.minKobo)} ` : "";
    return `Transfers ${from}go through ${most === 1 ? "one approval level" : `up to ${most} approval levels`}, depending on the amount.`;
  }
  if (rule.mode === "always") return "Every transfer needs a second person's approval.";
  if (rule.mode === "above_threshold" && rule.thresholdKobo !== null) {
    return `Transfers of ${formatNaira(rule.thresholdKobo)} or more need a second person's approval.`;
  }
  // "never", and any mode this version doesn't know yet.
  return "Only transfers prepared by team members who can't approve need approval.";
}

export type SimpleApprovalRule = { mode: "never" } | { mode: "always" } | { mode: "above_threshold"; thresholdKobo: number };

/** Changing the rule is a security setting, so it needs the transaction PIN (this request's header only). */
export const saveApprovalRule = (approval: SimpleApprovalRule, pin: string) =>
  api<{ approval: ApprovalRule }>("/api/transfers/settings", { method: "PATCH", json: { approval }, headers: pinHeader(pin) });

/** After the rule changes, everything for the business refreshes (who needs approval changes with it). */
export function useApprovalRuleSaved() {
  const qc = useQueryClient();
  const business = useBusinessKey();
  return () => void qc.invalidateQueries({ queryKey: [business] });
}
