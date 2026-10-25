import { create } from "zustand";
import { idempotencyKeys } from "@/lib/api/client";
import type { PayoutListRowInput, PayoutListWithItems } from "@/lib/api/payout-lists";
import type { Bank, BranchRef } from "@/lib/api/types";
import { useAuth } from "@/lib/auth/store";
import { useBusinessContext } from "@/lib/business-context";
import { koboToInput, type SavedRecipient } from "@/lib/bulk-draft";
import { formatNairaInput, parseNaira } from "@/lib/send-draft";

/**
 * Payout lists being edited or paid, shared by their screens (docs/briefs/bulk-payouts.md). Memory only, like the
 * bulk transfer draft.
 *
 * - useListDraft: a new list or an edit, shared by the editor, the beneficiary picker, the row editor and "Add a
 *   new account".
 * - usePayoutRun: paying a list, shared by the pay screen (account, this time's amounts, who's left out) and the
 *   review.
 */

const pick = (b: SavedRecipient): SavedRecipient => ({
  _id: b._id,
  accountName: b.accountName,
  accountNumber: b.accountNumber,
  bankName: b.bankName,
  nickname: b.nickname,
  ...(b.bankUuid && { bankUuid: b.bankUuid }),
});

let lastId = 0;
const newId = () => `list-row-${Date.now().toString(36)}-${++lastId}`;

// ---- Editing a list ----

export type ListRow = { id: string; beneficiary: SavedRecipient; amountKobo: number | null; narration?: string };

/** The row editor's form. `id` is the row being edited. */
export type ListRowForm = { id?: string; amount: string; narration: string };

/** "Add a new account": checked with its bank and saved as a beneficiary, then added to the list. */
export type NewAccountForm = { bank?: Bank; accountNumber: string; nickname: string };

type ListState = {
  business?: string;
  /** The list being edited; none for a new one. */
  listId?: string;
  title: string;
  /** The account it pays from by default; null for "Choose each time". */
  branch: string | null;
  rows: ListRow[];
  /** Rows on the saved list whose beneficiary has been deleted since. They can't be paid, so saving leaves them out. */
  dropped: number;
  /** Why the last save refused a row, by row id. */
  serverErrors: Record<string, string>;
  form: ListRowForm;
  account: NewAccountForm;
  /**
   * The Idempotency-Key for saving a new list, by what's saved: the same details keep their key (after a lost
   * answer or a wrong PIN), so a list can't be saved twice. Kept until a list is saved, then fresh.
   */
  keyFor: (body: unknown) => string;
};

type ListActions = {
  /** Opening the editor: a blank list, or the one being edited as it is now. */
  start: (business: string, list?: PayoutListWithItems, branch?: string | null) => void;
  set: (d: Partial<Pick<ListState, "title" | "branch">>) => void;
  /** Adds people who aren't on the list yet, up to MAX rows. Returns how many were added. */
  addPeople: (people: SavedRecipient[], max: number) => number;
  saveRow: (id: string, patch: Pick<ListRow, "amountKobo" | "narration">) => void;
  removeRow: (id: string) => void;
  editRow: (id: string) => void;
  updateForm: (f: Partial<ListRowForm>) => void;
  updateAccount: (a: Partial<NewAccountForm>) => void;
  setServerErrors: (errors: Record<string, string>) => void;
  /** After a list is saved, or its key was refused for other details (IDEMPOTENCY_KEY_REUSED): new keys. */
  freshKeys: () => void;
};

const blankAccount = (): NewAccountForm => ({ accountNumber: "", nickname: "" });

export const useListDraft = create<ListState & ListActions>((set, get) => ({
  title: "",
  branch: null,
  rows: [],
  dropped: 0,
  serverErrors: {},
  form: { amount: "", narration: "" },
  account: blankAccount(),
  keyFor: idempotencyKeys(),
  start: (business, list, branch = null) =>
    set((s) => ({
      business,
      listId: list?._id,
      title: list?.title ?? "",
      branch: list ? (list.branch?._id ?? null) : branch,
      rows: (list?.items ?? []).flatMap((i) =>
        i.beneficiary ? [{ id: newId(), beneficiary: pick(i.beneficiary), amountKobo: i.amountKobo, narration: i.narration ?? undefined }] : [],
      ),
      dropped: (list?.items ?? []).filter((i) => !i.beneficiary).length,
      serverErrors: {},
      form: { amount: "", narration: "" },
      account: blankAccount(),
      // Another business's keys never carry over.
      keyFor: s.business === business ? s.keyFor : idempotencyKeys(),
    })),
  set: (d) => set(d),
  addPeople: (people, max) => {
    const s = get();
    const on = new Set(s.rows.map((r) => r.beneficiary._id));
    const fresh = people.filter((p) => !on.has(p._id)).slice(0, Math.max(0, max - s.rows.length));
    if (fresh.length) set({ rows: [...s.rows, ...fresh.map((b) => ({ id: newId(), beneficiary: pick(b), amountKobo: null }))] });
    return fresh.length;
  },
  saveRow: (id, patch) =>
    set((s) => {
      const { [id]: _fixed, ...serverErrors } = s.serverErrors;
      return { rows: s.rows.map((r) => (r.id === id ? { ...r, ...patch } : r)), serverErrors };
    }),
  removeRow: (id) =>
    set((s) => {
      const { [id]: _gone, ...serverErrors } = s.serverErrors;
      return { rows: s.rows.filter((r) => r.id !== id), serverErrors };
    }),
  editRow: (id) =>
    set((s) => {
      const row = s.rows.find((r) => r.id === id);
      return { form: { id, amount: row?.amountKobo ? koboToInput(row.amountKobo) : "", narration: row?.narration ?? "" } };
    }),
  updateForm: (f) => set((s) => ({ form: { ...s.form, ...f } })),
  updateAccount: (a) => set((s) => ({ account: { ...s.account, ...a } })),
  setServerErrors: (serverErrors) => set({ serverErrors }),
  freshKeys: () => set({ keyFor: idempotencyKeys() }),
}));

/** The rows as the API saves them. */
export const listItems = (rows: ListRow[]): PayoutListRowInput[] =>
  rows.map((r) => ({ beneficiary: r.beneficiary._id, amountKobo: r.amountKobo ?? 0, narration: r.narration?.trim() || undefined }));

// ---- Paying a list ----

export type RunRow = {
  /** Local only: the row's place on the list and its beneficiary. */
  key: string;
  /**
   * The saved name is the one the member reviews; a changed one (ACCOUNT_NAME_CHANGED) replaces it once shown. Always
   * with its bank's uuid, which the run's key follows.
   */
  beneficiary: SavedRecipient & { bankUuid: string };
  /** The amount saved on the list. */
  savedKobo: number;
  narration: string | null;
  /** This time's amount, as typed ("25,000.50"). */
  amount: string;
  /** Paid this time. */
  include: boolean;
};

export type RunList = Pick<PayoutListWithItems, "_id" | "title" | "updatedAt"> & { branch: BranchRef | null };

type RunState = {
  business?: string;
  list?: RunList;
  rows: RunRow[];
  /** Rows whose beneficiary has been deleted since: they can't be paid. */
  gone: number;
  /** Branch whose account the money leaves. */
  from?: string;
  /** "Save these changes to the list" (saveItems). */
  saveItems: boolean;
  /** Rows the bank now names differently, by row key, with the name the member saw first. Nothing goes until they've looked. */
  renamed: Record<string, string>;
  /** Why the last run refused a row (INVALID_ROWS, other than a changed name), by row key. */
  serverErrors: Record<string, string>;
  /**
   * The Idempotency-Key for a run, by what's paid (the list, the account and the rows). It survives leaving and
   * opening the list again, so paying after a lost answer replays the first run; it's fresh after a run went.
   */
  keyFor: (body: unknown) => string;
};

type RunActions = {
  /** Opening Pay: carries on with the same list as it was left, unless the list changed or it's another business. */
  open: (business: string, list: PayoutListWithItems, from?: string) => void;
  set: (d: Partial<Pick<RunState, "from" | "saveItems">>) => void;
  update: (key: string, patch: Partial<Pick<RunRow, "amount" | "include">>) => void;
  /** "Use the list's amounts": everyone back in, at the saved amounts. */
  resetAmounts: () => void;
  /** Leaves these rows out this time. */
  leaveOut: (keys: string[]) => void;
  markRenamed: (changes: { key: string; accountName: string }[]) => void;
  acceptRenamed: () => void;
  setServerErrors: (errors: Record<string, string>) => void;
  /** After a run went (or IDEMPOTENCY_KEY_REUSED): the next payment is a new request. */
  freshKeys: () => void;
  /** After a run went: forget it, so Pay starts again from the list as it is now. */
  finish: () => void;
};

const runRows = (list: PayoutListWithItems): RunRow[] =>
  list.items.flatMap((i, n) =>
    i.beneficiary
      ? [
          {
            key: `${n}:${i.beneficiary._id}`,
            beneficiary: { ...pick(i.beneficiary), bankUuid: i.beneficiary.bankUuid },
            savedKobo: i.amountKobo,
            narration: i.narration,
            amount: formatNairaInput(koboToInput(i.amountKobo)),
            include: true,
          },
        ]
      : [],
  );

const fromList = (list: PayoutListWithItems) => ({
  list: { _id: list._id, title: list.title, branch: list.branch, updatedAt: list.updatedAt },
  rows: runRows(list),
  gone: list.items.filter((i) => !i.beneficiary).length,
  saveItems: false,
  renamed: {},
  serverErrors: {},
});

export const usePayoutRun = create<RunState & RunActions>((set) => ({
  rows: [],
  gone: 0,
  saveItems: false,
  renamed: {},
  serverErrors: {},
  keyFor: idempotencyKeys(),
  open: (business, list, from) =>
    set((s) => {
      if (s.business !== business) return { business, ...fromList(list), from, keyFor: idempotencyKeys() };
      if (s.list?._id === list._id && s.list.updatedAt === list.updatedAt) return { from: s.from ?? from };
      // The keys stay: they follow the list, the account and the rows, so the same payment can't go twice.
      return { ...fromList(list), from };
    }),
  set: (d) => set(d),
  update: (key, patch) =>
    set((s) => {
      const { [key]: _changed, ...serverErrors } = s.serverErrors;
      return { rows: s.rows.map((r) => (r.key === key ? { ...r, ...patch } : r)), serverErrors };
    }),
  resetAmounts: () =>
    set((s) => ({
      rows: s.rows.map((r) => ({ ...r, include: true, amount: formatNairaInput(koboToInput(r.savedKobo)) })),
      saveItems: false,
      serverErrors: {},
    })),
  leaveOut: (keys) =>
    set((s) => {
      const out = new Set(keys);
      const serverErrors = Object.fromEntries(Object.entries(s.serverErrors).filter(([k]) => !out.has(k)));
      const renamed = Object.fromEntries(Object.entries(s.renamed).filter(([k]) => !out.has(k)));
      return { rows: s.rows.map((r) => (out.has(r.key) ? { ...r, include: false } : r)), serverErrors, renamed };
    }),
  markRenamed: (changes) =>
    set((s) => {
      const renamed = { ...s.renamed };
      let rows = s.rows;
      for (const c of changes) {
        const row = rows.find((r) => r.key === c.key);
        if (!row || row.beneficiary.accountName === c.accountName) continue;
        // The name the member saw first stays the one they're told they checked.
        renamed[c.key] ??= row.beneficiary.accountName;
        rows = rows.map((r) => (r.key === c.key ? { ...r, beneficiary: { ...r.beneficiary, accountName: c.accountName } } : r));
      }
      return { rows, renamed };
    }),
  acceptRenamed: () => set({ renamed: {} }),
  setServerErrors: (serverErrors) => set({ serverErrors }),
  freshKeys: () => set({ keyFor: idempotencyKeys() }),
  finish: () => set({ list: undefined, rows: [], gone: 0, saveItems: false, renamed: {}, serverErrors: {}, keyFor: idempotencyKeys() }),
}));

/** This time's amount, in kobo; null if it isn't a naira amount. */
export const runKobo = (r: RunRow) => parseNaira(r.amount) ?? null;

/** Whether this run differs from the list: an amount, someone left out, or rows that can't be paid any more. */
export const runChanged = (rows: RunRow[], gone: number) => gone > 0 || rows.some((r) => !r.include || runKobo(r) !== r.savedKobo);

/** The rows paid this time, as the API takes them, each with the saved name the member is looking at. */
export const runItems = (rows: RunRow[]) =>
  rows
    .filter((r) => r.include)
    .map((r) => ({ beneficiary: r.beneficiary._id, amountKobo: runKobo(r) ?? 0, narration: r.narration ?? undefined, accountName: r.beneficiary.accountName }));

/**
 * What a run's Idempotency-Key follows: the list, the account paid from, and each row's account number, bank uuid,
 * amount and narration, exactly as the API's request hash sees them (docs/briefs/bulk-payouts.md) and as the web
 * keys a run. A row is the account it pays, not the saved beneficiary: after a lost answer, an edit that points a
 * row at another beneficiary for the same account (deleted and saved again) keeps the key, so the retry replays
 * instead of paying again.
 *
 * Left out: the reviewed names (the hash ignores them, so a retry after a changed name was checked replays) and
 * "save these changes", so ticking it after a lost answer can't pay the same people again.
 */
export const runKeyBody = (listId: string, branch: string, rows: RunRow[]) => ({
  list: listId,
  branch,
  items: rows
    .filter((r) => r.include)
    .map((r) => ({
      accountNumber: r.beneficiary.accountNumber,
      bankUuid: r.beneficiary.bankUuid,
      amountKobo: runKobo(r) ?? 0,
      narration: r.narration ?? null,
    })),
});

/** What a preview was worked out for: the account and the rows, not the names (they can be checked again). */
export const runPreviewKey = (branch: string | undefined, rows: RunRow[]) =>
  JSON.stringify([branch ?? null, runItems(rows).map((i) => [i.beneficiary, i.amountKobo, i.narration ?? null])]);

/** Beneficiaries from the picker or a new save, as the list keeps them. */
export const recipientOf = (b: SavedRecipient): SavedRecipient => pick(b);

/** Both drafts forgotten, with new keys. */
function forgetDrafts() {
  useListDraft.getState().start("");
  useListDraft.getState().freshKeys();
  usePayoutRun.setState({ business: undefined });
  usePayoutRun.getState().finish();
}

// Signing out forgets both, so the next person to sign in on this phone never sees them. So does switching
// business: their rows are the last business's beneficiaries (and opening either for another business would start
// afresh, keys included, anyway).
useAuth.subscribe((s, prev) => {
  if (s.status === "signedOut" && prev.status !== "signedOut") forgetDrafts();
});
useBusinessContext.subscribe((s, prev) => {
  if (s.businessId !== prev.businessId) forgetDrafts();
});
