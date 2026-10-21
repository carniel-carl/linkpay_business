import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useBusinessContext } from "@/lib/business-context";
import { queryClient } from "@/lib/query";
import { api } from "./client";
import type { Safelock, SafelockLimits, SafelockList } from "./types";

// /api/safelocks (docs/briefs/savings.md §6). Reads need accounts.view; create and rename need savings.manage.
// There are no routes to break, top up, shorten or extend a lock, so there's nothing here for them either.

const useBusinessKey = () => useBusinessContext((s) => s.businessId ?? "default");
const path = (id: string) => `/api/safelocks/${encodeURIComponent(id)}`;

export type SafelockStatusFilter = "locked" | "released";

/** The amount and date window for a new lock. The window moves with the day, so it's refetched hourly. */
export function useSafelockLimits(enabled = true) {
  const business = useBusinessKey();
  return useQuery({
    queryKey: [business, "safelocks", "limits"],
    queryFn: () => api<SafelockLimits>("/api/safelocks/limits"),
    staleTime: 60 * 60_000,
    enabled,
  });
}

/** Running locks (soonest to unlock first) or released ones (latest first). Reading also releases due ones. */
export function useSafelocks({ status, branch, enabled = true }: { status: SafelockStatusFilter; branch?: string; enabled?: boolean }) {
  const business = useBusinessKey();
  return useQuery({
    queryKey: [business, "safelocks", "list", status, branch],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ status });
      if (branch) params.set("branch", branch);
      return api<SafelockList>(`/api/safelocks?${params}`, { signal });
    },
    placeholderData: keepPreviousData,
    enabled,
    refetchInterval: 5 * 60_000,
  });
}

/** One lock. Opens instantly from the list it was tapped in, then refreshes from the server. */
export function useSafelock(id: string | undefined) {
  const business = useBusinessKey();
  return useQuery({
    queryKey: [business, "safelock", id],
    queryFn: () => api<Safelock>(path(id!)),
    enabled: !!id,
    placeholderData: () => {
      for (const [, data] of queryClient.getQueriesData<SafelockList>({ queryKey: [business, "safelocks", "list"] })) {
        const found = data?.items.find((s) => s._id === id);
        if (found) return found;
      }
      return undefined;
    },
  });
}

export type SafelockInput = { branch: string; title: string; amountKobo: number; unlockOn: string };

/**
 * Locks money. The Idempotency-Key makes a retried create (dropped connection) return the same lock.
 * Balances refresh, since the amount leaves the branch's available balance.
 */
export function useCreateSafelock() {
  const qc = useQueryClient();
  const business = useBusinessKey();
  return useMutation({
    mutationFn: ({ input, idempotencyKey }: { input: SafelockInput; idempotencyKey: string }) =>
      api<Safelock>("/api/safelocks", { method: "POST", json: input, headers: { "Idempotency-Key": idempotencyKey } }),
    onSuccess: (lock) => {
      qc.setQueryData([business, "safelock", lock._id], lock);
      void qc.invalidateQueries({ queryKey: [business, "safelocks"] });
      void qc.invalidateQueries({ queryKey: [business, "accounts"] });
    },
  });
}

/** The title is the only thing that can change, and only while it's locked. */
export function useRenameSafelock() {
  const qc = useQueryClient();
  const business = useBusinessKey();
  return useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) => api<Safelock>(path(id), { method: "PATCH", json: { title } }),
    onSuccess: (lock) => {
      qc.setQueryData([business, "safelock", lock._id], lock);
      void qc.invalidateQueries({ queryKey: [business, "safelocks", "list"] });
    },
  });
}
