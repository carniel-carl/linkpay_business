import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useBusinessContext } from "@/lib/business-context";
import { formatNaira } from "@/lib/format";
import { api, MONEY_TIMEOUT_MS } from "./client";
import { idSegment } from "./paths";
import type { ApprovalRule, ApprovalTier, Bank, FeeQuote, ResolvedAccount, Transfer, TransferList, TransferStatus } from "./types";

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

/** `q` searches the recipient, reference and narration. */
export function useTransfers(tab: TransferTab, { enabled = true, q }: { enabled?: boolean; q?: string } = {}) {
  const business = useBusinessKey();
  return useInfiniteQuery({
    queryKey: [business, "transfers", tab, q],
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams({ skip: String(pageParam), take: "30" });
      if (tab === "awaiting") params.set("awaiting", "me");
      else if (tab !== "all") params.set("status", tab);
      if (q) params.set("q", q);
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

/** Transfers that went through approval: waiting at any level, approved and sent, or declined. */
export function useApprovals(tab: ApprovalTab, q?: string) {
  const business = useBusinessKey();
  return useInfiniteQuery({
    queryKey: [business, "transfers", "approvals", tab, q],
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams({ approval: tab, skip: String(pageParam), take: "30" });
      if (q) params.set("q", q);
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

/** Approve, reject, cancel or refresh. Money and lists change, so everything for the business refreshes. */
export function useTransferAction() {
  const qc = useQueryClient();
  const business = useBusinessKey();
  return useMutation({
    mutationFn: ({ id, action, note }: { id: string; action: "approve" | "reject" | "cancel" | "refresh"; note?: string }) =>
      api<Transfer>(`/api/transfers/${idSegment(id)}/${action}`, {
        method: "POST",
        json: action === "approve" || action === "reject" ? { note: note || undefined } : {},
        // The last approval sends the payout in the same request.
        timeoutMs: MONEY_TIMEOUT_MS,
      }),
    onSuccess: (t) => {
      qc.setQueryData([business, "transfer", t._id], t);
      void qc.invalidateQueries({ queryKey: [business] });
    },
  });
}

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

export function useFee(amountKobo: number | undefined) {
  const business = useBusinessKey();
  return useQuery({
    queryKey: [business, "fee", amountKobo],
    queryFn: () => api<FeeQuote>(`/api/transfers/fee?amountKobo=${amountKobo}`),
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

/** Creates one transfer. The Idempotency-Key makes a retried send (dropped connection) return the same transfer. */
export const sendTransfer = (body: SendRequest, idempotencyKey: string) =>
  api<Transfer>("/api/transfers", { method: "POST", json: body, headers: { "Idempotency-Key": idempotencyKey }, timeoutMs: MONEY_TIMEOUT_MS });

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

export function useSaveApprovalRule() {
  const qc = useQueryClient();
  const business = useBusinessKey();
  return useMutation({
    mutationFn: (approval: { mode: "never" } | { mode: "always" } | { mode: "above_threshold"; thresholdKobo: number }) =>
      api<{ approval: ApprovalRule }>("/api/transfers/settings", { method: "PATCH", json: { approval } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: [business] }),
  });
}
