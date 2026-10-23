import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useBusinessContext } from "@/lib/business-context";
import { queryClient } from "@/lib/query";
import { api, MONEY_TIMEOUT_MS } from "./client";
import type { Pocket, PocketActivity, PocketColor, PocketIcon, PocketList, PocketMovement } from "./types";

// /api/pockets (docs/briefs/savings.md). Reads need accounts.view; every write needs savings.manage.

const useBusinessKey = () => useBusinessContext((s) => s.businessId ?? "default");
const path = (id: string, rest = "") => `/api/pockets/${encodeURIComponent(id)}${rest}`;

export type PocketStatusFilter = "active" | "closed";

/**
 * Pockets the member can see, open ones first. Auto-save can change a balance at any minute, so the list
 * refreshes every minute while it's on screen.
 */
export function usePockets({ status, branch, enabled = true }: { status: PocketStatusFilter; branch?: string; enabled?: boolean }) {
  const business = useBusinessKey();
  return useQuery({
    queryKey: [business, "pockets", "list", status, branch],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ status });
      if (branch) params.set("branch", branch);
      return api<PocketList>(`/api/pockets?${params}`, { signal });
    },
    placeholderData: keepPreviousData,
    enabled,
    refetchInterval: 60_000,
  });
}

/** One pocket. Opens instantly from the list it was tapped in, then refreshes from the server. */
export function usePocket(id: string | undefined) {
  const business = useBusinessKey();
  return useQuery({
    queryKey: [business, "pocket", id],
    queryFn: () => api<Pocket>(path(id!)),
    enabled: !!id,
    refetchInterval: 60_000,
    placeholderData: () => {
      for (const [, data] of queryClient.getQueriesData<PocketList>({ queryKey: [business, "pockets", "list"] })) {
        const found = data?.items.find((p) => p._id === id);
        if (found) return found;
      }
      return undefined;
    },
  });
}

/** A pocket's movements, newest first, 20 at a time. */
export function usePocketActivity(id: string | undefined) {
  const business = useBusinessKey();
  return useInfiniteQuery({
    queryKey: [business, "pocket", id, "activity"],
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams({ take: "20" });
      if (pageParam) params.set("before", pageParam);
      return api<PocketActivity>(path(id!, `/activity?${params}`), { signal });
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    enabled: !!id,
  });
}

// ---- Changes ----

export type PocketInput = {
  branch: string;
  name: string;
  icon: PocketIcon | null;
  color: PocketColor;
  target: { amountKobo: number; date: string | null } | null;
  autoSave: { percentBps: number } | { amountKobo: number } | null;
};

/** The branch can't change after creation. `null` removes the icon, target or auto-save. */
export type PocketPatch = Partial<Omit<PocketInput, "branch">>;

type Change =
  | { kind: "create"; input: PocketInput }
  | { kind: "update"; id: string; input: PocketPatch }
  | { kind: "deposit" | "withdraw"; id: string; amountKobo: number; note?: string; idempotencyKey: string }
  | { kind: "close"; id: string };

async function run(change: Change): Promise<Pocket> {
  switch (change.kind) {
    case "create": {
      // Leave out what isn't set, rather than sending nulls to the create endpoint.
      const { icon, target, autoSave, ...rest } = change.input;
      return api<Pocket>("/api/pockets", {
        method: "POST",
        json: { ...rest, ...(icon && { icon }), ...(target && { target }), ...(autoSave && { autoSave }) },
      });
    }
    case "update":
      return api<Pocket>(path(change.id), { method: "PATCH", json: change.input });
    case "deposit":
    case "withdraw": {
      const res = await api<{ pocket: Pocket; movement: PocketMovement }>(path(change.id, `/${change.kind}`), {
        method: "POST",
        json: { amountKobo: change.amountKobo, ...(change.note && { note: change.note }) },
        headers: { "Idempotency-Key": change.idempotencyKey },
        timeoutMs: MONEY_TIMEOUT_MS,
      });
      return res.pocket;
    }
    case "close":
      return api<Pocket>(path(change.id, "/close"), { method: "POST", json: {} });
  }
}

/**
 * Every change to a pocket. The answer replaces the cached pocket; lists refresh, and so do balances, since
 * money in pockets comes out of each account's available balance.
 */
export function usePocketChange() {
  const qc = useQueryClient();
  const business = useBusinessKey();
  return useMutation({
    mutationFn: run,
    onSuccess: (pocket, change) => {
      qc.setQueryData([business, "pocket", pocket._id], pocket);
      void qc.invalidateQueries({ queryKey: [business, "pockets"] });
      if (change.kind !== "create" && change.kind !== "update") {
        void qc.invalidateQueries({ queryKey: [business, "pocket", pocket._id, "activity"] });
        void qc.invalidateQueries({ queryKey: [business, "accounts"] });
      }
    },
  });
}
