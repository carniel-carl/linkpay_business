import { keepPreviousData, useInfiniteQuery, useQuery, type InfiniteData } from "@tanstack/react-query";
import { useBusinessContext } from "@/lib/business-context";
import { periodStart, type Period } from "@/lib/periods";
import { queryClient } from "@/lib/query";
import { api } from "./client";
import { idSegment } from "./paths";
import { ApiError } from "./errors";
import type {
  Account,
  Branch,
  MembershipSummary,
  Overview,
  Permission,
  Transaction,
  TransactionList,
  TransactionStatus,
  TransactionSummary,
} from "./types";

// Every key starts with the business in the switcher, so switching never shows another business's data.
const useBusinessKey = () => useBusinessContext((s) => s.businessId ?? "default");

export const can = (overview: Overview | undefined, permission: Permission) => !!overview?.membership?.permissions.includes(permission);

/** GET /api/business. A user who hasn't started a business gets a 404 with BUSINESS_REQUIRED. */
export function useOverview({ refetchInterval }: { refetchInterval?: number } = {}) {
  const business = useBusinessKey();
  return useQuery({ queryKey: [business, "overview"], queryFn: () => api<Overview>("/api/business"), refetchInterval });
}

export function useMemberships() {
  return useQuery({ queryKey: ["memberships"], queryFn: () => api<MembershipSummary[]>("/api/memberships"), staleTime: 5 * 60_000 });
}

/** Balances are live from the bank, so they refresh every minute while Home is open. */
export function useAccounts(enabled: boolean) {
  const business = useBusinessKey();
  return useQuery({
    queryKey: [business, "accounts"],
    queryFn: async () => {
      try {
        return await api<Account[]>("/api/accounts");
      } catch (err) {
        // No account is open yet: the branches still show, each with its setup state.
        if (err instanceof ApiError && err.code === "ACCOUNT_NOT_READY") return [];
        throw err;
      }
    },
    enabled,
    refetchInterval: 60_000,
  });
}

/** A branch and its account, if open. The deck's cards, head office first. */
export type BranchCard = { branch: Branch; account?: Account };

export function branchCards(overview: Overview | undefined, accounts: Account[] | undefined): BranchCard[] {
  return (overview?.branches ?? []).map((branch) => ({ branch, account: accounts?.find((a) => a.branch?._id === branch._id) }));
}

// ---- Transactions ----

export type PaymentFilters = { period: Period; branch?: string; status?: TransactionStatus; q?: string };

const PAGE = 30;

function filterParams(f: Omit<PaymentFilters, "status" | "q"> & Partial<PaymentFilters>) {
  const params = new URLSearchParams();
  const from = periodStart(f.period);
  if (from) params.set("from", from.toISOString());
  if (f.branch) params.set("branch", f.branch);
  if (f.status) params.set("status", f.status);
  if (f.q) params.set("q", f.q);
  return params;
}

export function useTransactions(filters: PaymentFilters, { enabled = true, take = PAGE, refetchInterval }: { enabled?: boolean; take?: number; refetchInterval?: number } = {}) {
  const business = useBusinessKey();
  return useInfiniteQuery({
    queryKey: [business, "transactions", filters, take],
    queryFn: ({ pageParam, signal }) => {
      const params = filterParams(filters);
      params.set("skip", String(pageParam));
      params.set("take", String(take));
      return api<TransactionList>(`/api/transactions?${params}`, { signal });
    },
    initialPageParam: 0,
    getNextPageParam: (last) => (last.skip + last.items.length < last.total ? last.skip + last.items.length : undefined),
    placeholderData: keepPreviousData,
    enabled,
    refetchInterval,
  });
}

/** Money in for the period and branch (successful payments only). */
export function useTransactionSummary(filters: Pick<PaymentFilters, "period" | "branch">, { enabled = true, refetchInterval }: { enabled?: boolean; refetchInterval?: number } = {}) {
  const business = useBusinessKey();
  return useQuery({
    queryKey: [business, "transactions", "summary", filters.period, filters.branch],
    queryFn: () => api<TransactionSummary>(`/api/transactions/summary?${filterParams(filters)}`),
    placeholderData: keepPreviousData,
    enabled,
    refetchInterval,
  });
}

/** One payment. Opens instantly from any list it was tapped in, then refreshes from the server. */
export function useTransaction(id: string) {
  const business = useBusinessKey();
  return useQuery({
    queryKey: [business, "transaction", id],
    queryFn: () => api<Transaction>(`/api/transactions/${idSegment(id)}`),
    placeholderData: () => {
      for (const [, data] of queryClient.getQueriesData<InfiniteData<TransactionList>>({ queryKey: [business, "transactions"] })) {
        const found = data?.pages?.flatMap((p) => p.items).find((t) => t._id === id);
        if (found) return found;
      }
      return undefined;
    },
  });
}
