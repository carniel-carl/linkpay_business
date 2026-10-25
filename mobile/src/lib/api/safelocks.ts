import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useBusinessContext } from "@/lib/business-context";
import { queryClient } from "@/lib/query";
import { api, keptIdempotencyKeys, MONEY_TIMEOUT_MS } from "./client";
import { idSegment } from "./paths";
import { pinHeader } from "./transaction-pin";
import type { Safelock, SafelockLimits, SafelockList } from "./types";

// /api/safelocks (docs/briefs/savings.md §6). Reads need accounts.view; create and rename need savings.manage,
// and create also the transaction PIN.
// There are no routes to break, top up, shorten or extend a lock, so there's nothing here for them either.

const useBusinessKey = () => useBusinessContext((s) => s.businessId ?? "default");
const path = (id: string) => `/api/safelocks/${idSegment(id)}`;

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
 * The New Safelock form's Idempotency-Keys, by its input (the branch, name, amount and unlock date: what the API's
 * request hash covers). Kept outside the screen, so a lock whose answer was lost, filled in again after leaving
 * the form, keeps its key and locks the money once. New after a lock is made, or IDEMPOTENCY_KEY_REUSED.
 */
export const safelockKeys = keptIdempotencyKeys();

/**
 * Locks money, with the transaction PIN as this request's header (a plain call, so the PIN stays out of
 * react-query's state). The Idempotency-Key makes a retried create (dropped connection) return the same lock;
 * the PIN isn't part of the body, so retrying with a corrected PIN keeps the same key.
 */
export const createSafelock = (input: SafelockInput, idempotencyKey: string, pin: string) =>
  api<Safelock>("/api/safelocks", {
    method: "POST",
    json: input,
    headers: { "Idempotency-Key": idempotencyKey, ...pinHeader(pin) },
    timeoutMs: MONEY_TIMEOUT_MS,
  });

/** After a lock is created. Balances refresh, since the amount leaves the branch's available balance. */
export function useSafelockCreated() {
  const qc = useQueryClient();
  const business = useBusinessKey();
  return (lock: Safelock) => {
    qc.setQueryData([business, "safelock", lock._id], lock);
    void qc.invalidateQueries({ queryKey: [business, "safelocks"] });
    void qc.invalidateQueries({ queryKey: [business, "accounts"] });
  };
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
