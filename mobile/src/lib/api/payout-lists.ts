import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useBusinessContext } from "@/lib/business-context";
import { api, BULK_MONEY_TIMEOUT_MS } from "./client";
import { idSegment } from "./paths";
import { pinHeader } from "./transaction-pin";
import type { BranchRef, BulkResult } from "./types";

// /api/payout-lists (docs/briefs/bulk-payouts.md): saved bulk payouts, like "Monthly salaries". Reads need
// accounts.view; creating, editing, deleting and running need transfers.create. Creating, editing and running take
// the transaction PIN (docs/briefs/transaction-pin.md), as this one request's header; deleting moves no money, so
// it doesn't. Running a list makes an ordinary bulk transfer, with the approval rules and the balance check.

const useBusinessKey = () => useBusinessContext((s) => s.businessId ?? "default");
const listPath = (id: string, rest = "") => `/api/payout-lists/${idSegment(id)}${rest}`;

/** The most lists a business can save (PAYOUT_LIST_LIMIT), and rows in one, as in one bulk transfer. */
export const MAX_LISTS = 100;
export const MAX_LIST_ROWS = 200;
export const MAX_LIST_TITLE = 80;
export const MAX_NARRATION = 100;

/** A list's row as the API gives it. `beneficiary` is null when that beneficiary was deleted since: it can't be paid. */
export type PayoutListItem = {
  beneficiary: { _id: string; accountName: string; nickname: string | null; accountNumber: string; bankName: string | null } | null;
  amountKobo: number;
  narration: string | null;
};

/** GET /api/payout-lists items. Totals are before fees; the run's review quotes them. */
export type PayoutList = {
  _id: string;
  title: string;
  /** The account it pays from by default; null means "choose each time". */
  branch: BranchRef | null;
  count: number;
  amountKobo: number;
  lastRunAt: string | null;
  /** The last run: a bulk transfer, or one plain transfer when it paid a single person. At most one is set. */
  lastBatch: string | null;
  lastTransfer: string | null;
  createdBy: { _id: string; name: string } | null;
  createdAt: string;
  updatedAt: string;
};

/** GET /:id, POST and PATCH: the list with its rows. */
export type PayoutListWithItems = PayoutList & { items: PayoutListItem[] };

/** A row as the API takes it when saving a list. */
export type PayoutListRowInput = { beneficiary: string; amountKobo: number; narration?: string };

export type PayoutListInput = { title: string; branch?: string | null; items: PayoutListRowInput[] };

/**
 * A run's rows: this time's amounts, each with the saved name the member reviewed (`accountName`), so a name that
 * changed since is refused with ACCOUNT_NAME_CHANGED. The names aren't part of the Idempotency-Key's request hash.
 */
export type PayoutListRunRequest = { branch: string; items: (PayoutListRowInput & { accountName?: string })[]; saveItems?: boolean };

/** Most recently changed first, without their rows. */
export function usePayoutLists(enabled = true) {
  const business = useBusinessKey();
  return useQuery({
    queryKey: [business, "payout-lists"],
    queryFn: ({ signal }) => api<{ items: PayoutList[] }>("/api/payout-lists", { signal }),
    select: (d) => d.items,
    enabled,
  });
}

/** One list with its rows. */
export function usePayoutList(id: string | undefined) {
  const business = useBusinessKey();
  return useQuery({
    queryKey: [business, "payout-list", id],
    queryFn: ({ signal }) => api<PayoutListWithItems>(listPath(id!), { signal }),
    enabled: !!id,
  });
}

/** After a list is saved: the answer replaces the cached list, and the lists (and beneficiaries' "in a list") refresh. */
export function usePayoutListSaved() {
  const qc = useQueryClient();
  const business = useBusinessKey();
  return (list: PayoutListWithItems) => {
    qc.setQueryData([business, "payout-list", list._id], list);
    void qc.invalidateQueries({ queryKey: [business, "payout-lists"] });
  };
}

/** After a list is deleted, or found gone (PAYOUT_LIST_NOT_FOUND): forget it and refresh the lists. */
export function usePayoutListGone() {
  const qc = useQueryClient();
  const business = useBusinessKey();
  return (id: string) => {
    qc.removeQueries({ queryKey: [business, "payout-list", id] });
    void qc.invalidateQueries({ queryKey: [business, "payout-lists"] });
  };
}

/**
 * Saves a new list. The Idempotency-Key follows the list's details, so saving the same list again after a lost
 * answer or a wrong PIN returns the list saved the first time instead of a second copy.
 */
export const createPayoutList = (body: PayoutListInput, idempotencyKey: string, pin: string) =>
  api<PayoutListWithItems>("/api/payout-lists", {
    method: "POST",
    json: { ...body, branch: body.branch ?? undefined },
    headers: { "Idempotency-Key": idempotencyKey, ...pinHeader(pin) },
  });

/** `branch: null` clears the default account; `items` replace the whole list. Sending it twice does no harm. */
export const updatePayoutList = (id: string, body: PayoutListInput, pin: string) =>
  api<PayoutListWithItems>(listPath(id), { method: "PATCH", json: body, headers: pinHeader(pin) });

/** Moves no money, so no PIN. Its beneficiaries stay saved, and its past payments stay in Transfers. */
export const deletePayoutList = (id: string) => api<void>(listPath(id), { method: "DELETE" });

/**
 * Pays the list as a bulk transfer (or one plain transfer for a single row). The PIN is this request's header
 * only, and the Idempotency-Key follows what's paid (the list, the account and the rows, not the reviewed names
 * or "save these changes"), so a retry after a lost answer, a wrong PIN or a re-checked name returns the first
 * run rather than paying again. It waits as long as a bulk transfer: the server checks every row with its bank first.
 */
export const runPayoutList = (id: string, body: PayoutListRunRequest, idempotencyKey: string, pin: string) =>
  api<BulkResult>(listPath(id, "/run"), {
    method: "POST",
    json: body,
    headers: { "Idempotency-Key": idempotencyKey, ...pinHeader(pin) },
    timeoutMs: BULK_MONEY_TIMEOUT_MS,
  });

/** "1 person", "4 people". */
export const people = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;
