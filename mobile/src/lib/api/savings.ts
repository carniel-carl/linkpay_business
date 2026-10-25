import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useBusinessContext } from "@/lib/business-context";
import { queryClient } from "@/lib/query";
import { api, keptIdempotencyKeys, MONEY_TIMEOUT_MS } from "./client";
import { idSegment } from "./paths";
import { pinHeader } from "./transaction-pin";
import type { Pocket, PocketActivity, PocketColor, PocketIcon, PocketList, PocketMovement } from "./types";

// /api/pockets (docs/briefs/savings.md). Reads need accounts.view; every write needs savings.manage, and
// withdrawing or closing also the transaction PIN.

const useBusinessKey = () => useBusinessContext((s) => s.businessId ?? "default");
const path = (id: string, rest = "") => `/api/pockets/${idSegment(id)}${rest}`;

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
  | { kind: "deposit"; id: string; amountKobo: number; note?: string; idempotencyKey: string };

type Movement = { amountKobo: number; note?: string };

/**
 * Add money and Withdraw's Idempotency-Keys, by the pocket, the direction, the amount and the note (the pocket scopes
 * the key; the rest is what the API's request hash covers). Kept outside the screen, so a move whose answer was
 * lost, filled in again after leaving it, keeps its key and moves the money once. New after a move went, or
 * IDEMPOTENCY_KEY_REUSED.
 */
export const pocketMoveKeys = keptIdempotencyKeys();

const move = async (kind: "deposit" | "withdraw", id: string, m: Movement, headers: Record<string, string>) =>
  (
    await api<{ pocket: Pocket; movement: PocketMovement }>(path(id, `/${kind}`), {
      method: "POST",
      json: { amountKobo: m.amountKobo, ...(m.note && { note: m.note }) },
      headers,
      timeoutMs: MONEY_TIMEOUT_MS,
    })
  ).pocket;

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
      return move("deposit", change.id, change, { "Idempotency-Key": change.idempotencyKey });
  }
}

// Taking money out of savings needs the transaction PIN; putting it in doesn't. These are plain calls rather than
// mutations, so the PIN stays out of react-query's state: it's only this request's header. Call usePocketMoved after.

/** Back to the branch's available balance. The PIN isn't part of the body, so a retry with a corrected PIN keeps the key. */
export const withdrawFromPocket = (id: string, m: Movement, idempotencyKey: string, pin: string) =>
  move("withdraw", id, m, { "Idempotency-Key": idempotencyKey, ...pinHeader(pin) });

/** Closes the pocket; what's in it goes back to the branch's available balance. */
export const closePocket = (id: string, pin: string) =>
  api<Pocket>(path(id, "/close"), { method: "POST", json: {}, headers: pinHeader(pin) });

/**
 * After money moves in or out of a pocket: the answer replaces the cached pocket, and lists, its activity and
 * balances refresh, since money in pockets comes out of each account's available balance.
 */
export function usePocketMoved() {
  const qc = useQueryClient();
  const business = useBusinessKey();
  return (pocket: Pocket) => {
    qc.setQueryData([business, "pocket", pocket._id], pocket);
    void qc.invalidateQueries({ queryKey: [business, "pockets"] });
    void qc.invalidateQueries({ queryKey: [business, "pocket", pocket._id, "activity"] });
    void qc.invalidateQueries({ queryKey: [business, "accounts"] });
  };
}

/** Creating, editing and adding money (none needs the PIN). The answer replaces the cached pocket; lists refresh. */
export function usePocketChange() {
  const qc = useQueryClient();
  const business = useBusinessKey();
  const moved = usePocketMoved();
  return useMutation({
    mutationFn: run,
    onSuccess: (pocket, change) => {
      if (change.kind === "deposit") return moved(pocket);
      qc.setQueryData([business, "pocket", pocket._id], pocket);
      void qc.invalidateQueries({ queryKey: [business, "pockets"] });
    },
  });
}
