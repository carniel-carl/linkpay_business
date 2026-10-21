import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useBusinessContext } from "@/lib/business-context";
import { formatNaira } from "@/lib/format";
import { api } from "./client";
import type { ApprovalRule, Bank, FeeQuote, ResolvedAccount, Transfer, TransferList, TransferStatus } from "./types";

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

export function useTransfer(id: string) {
  const business = useBusinessKey();
  return useQuery({
    queryKey: [business, "transfer", id],
    queryFn: () => api<Transfer>(`/api/transfers/${id}`),
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
      api<Transfer>(`/api/transfers/${id}/${action}`, { method: "POST", json: action === "approve" || action === "reject" ? { note: note || undefined } : {} }),
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
  api<Transfer>("/api/transfers", { method: "POST", json: body, headers: { "Idempotency-Key": idempotencyKey } });

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
