import { create } from "zustand";
import { idempotencyKeys } from "@/lib/api/client";
import { useAuth } from "@/lib/auth/store";
import type { Bank, Beneficiary, BulkRowInput, ResolvedAccount } from "@/lib/api/types";
import { amountProblem } from "@/lib/bulk-csv";

/**
 * A bulk transfer being prepared, shared by its screens: the list, the CSV paste, the beneficiary picker, the
 * row editor and the review. Memory only, like the single-transfer draft.
 */

/** The parts of a saved beneficiary a row shows and sends. */
export type SavedRecipient = Pick<Beneficiary, "_id" | "accountName" | "accountNumber" | "bankName" | "nickname">;

export type BulkRow = {
  /** Local only, for editing and removing. */
  id: string;
  /** A saved beneficiary: paid without a new name enquiry, under the name it was saved with. */
  beneficiary?: SavedRecipient;
  /** An account number and bank (unused for a beneficiary row). */
  accountNumber: string;
  bank?: Bank;
  /** A CSV line's bank text when it didn't name exactly one bank, and why. Cleared once a bank is chosen. */
  bankText?: string;
  bankError?: string;
  amountKobo: number | null;
  narration?: string;
  /** The CSV line it came from. */
  line?: number;
};

/** A name enquiry: the answer, or why it failed. */
export type Checked = { data?: ResolvedAccount; error?: string; code?: string };

/** The row editor's form. `id` is the row being edited; none for a new row. */
export type RowForm = {
  id?: string;
  beneficiary?: SavedRecipient;
  bank?: Bank;
  bankText?: string;
  bankError?: string;
  accountNumber: string;
  /** As typed, e.g. "25,000.50". */
  amount: string;
  narration: string;
};

type State = {
  /** The business the draft belongs to (its rows name its beneficiaries and branches). */
  business?: string;
  /** Branch whose account the money leaves. */
  from?: string;
  title: string;
  rows: BulkRow[];
  /** Name enquiries by lookupKey, kept while the draft lives, so fixing a row only checks what changed. */
  names: Record<string, Checked>;
  /** Accounts the bank now names differently, with the name the member checked before. Nothing goes until they've looked. */
  renamed: Record<string, string>;
  /** Why the last send refused a row (INVALID_ROWS, other than a changed name), by row id. */
  serverErrors: Record<string, string>;
  form: RowForm;
  /**
   * The Idempotency-Key for a send, by what's sent: the same rows from the same account keep their key (after a
   * lost answer, a wrong PIN, or a changed name checked again), so they can't be paid twice.
   */
  keyFor: (body: unknown) => string;
};

type Actions = {
  /**
   * Opening Bulk transfer: carries on with the list being prepared, so backing out by mistake loses nothing,
   * unless it belongs to another business. `from` picks the account if none is chosen yet.
   */
  open: (business: string, from?: string) => void;
  /** After a bulk transfer is sent, or "Remove all": a fresh draft, with its own keys. */
  start: (business?: string, from?: string) => void;
  set: (d: Partial<Pick<State, "from" | "title">>) => void;
  addRows: (rows: Omit<BulkRow, "id">[]) => void;
  /** Replaces the row with the same id, or adds it. */
  saveRow: (row: BulkRow) => void;
  removeRows: (ids: string[]) => void;
  setNames: (names: Record<string, Checked>) => void;
  /** Rows refused with ACCOUNT_NAME_CHANGED: show the bank's name now, and hold them until the member has looked. */
  markRenamed: (changes: { id: string; accountName: string }[]) => void;
  acceptRenamed: () => void;
  setServerErrors: (errors: Record<string, string>) => void;
  /** Opens the editor's form on a row, or blank for a new one. */
  editRow: (id?: string) => void;
  updateForm: (f: Partial<RowForm>) => void;
};

let lastId = 0;
const newId = () => `row-${Date.now().toString(36)}-${++lastId}`;

const blankForm = (): RowForm => ({ accountNumber: "", amount: "", narration: "" });

const blank = (business?: string, from?: string): State => ({
  business,
  from,
  title: "",
  rows: [],
  names: {},
  renamed: {},
  serverErrors: {},
  form: blankForm(),
  keyFor: idempotencyKeys(),
});

/** 2500050 -> "25000.50", for putting an amount back into a naira field. */
export const koboToInput = (kobo: number) => (kobo % 100 ? `${Math.trunc(kobo / 100)}.${String(kobo % 100).padStart(2, "0")}` : String(kobo / 100));

/** What a row's name enquiry is kept under: the bank and account number, or the saved beneficiary. */
export const lookupKey = (r: Pick<BulkRow, "beneficiary" | "bank" | "accountNumber">) =>
  r.beneficiary ? `beneficiary:${r.beneficiary._id}` : `${r.bank?.uuid}:${r.accountNumber}`;

/** What's wrong with a row before anything is asked of the bank, if anything. */
export function rowProblem(r: BulkRow) {
  if (!r.beneficiary) {
    if (!/^\d{10}$/.test(r.accountNumber)) return "Account numbers are 10 digits.";
    if (!r.bank) return r.bankError ?? "Choose the bank.";
  }
  if (r.amountKobo === null) return "Add the amount.";
  return amountProblem(r.amountKobo);
}

/** The name the member sees for a row: the saved beneficiary's, or the bank's answer. */
export const rowName = (r: BulkRow, names: Record<string, Checked>) => (r.beneficiary ? r.beneficiary.accountName : names[lookupKey(r)]?.data?.accountName);

/** The rows as the API takes them, each with the account name the member is looking at. */
export const apiItems = (rows: BulkRow[], names: Record<string, Checked>): BulkRowInput[] =>
  rows.map((r) =>
    r.beneficiary
      ? { beneficiary: r.beneficiary._id, amountKobo: r.amountKobo!, narration: r.narration, accountName: r.beneficiary.accountName }
      : { accountNumber: r.accountNumber, bankUuid: r.bank!.uuid, amountKobo: r.amountKobo!, narration: r.narration, accountName: names[lookupKey(r)]?.data?.accountName },
  );

/**
 * What the Idempotency-Key follows: the account and each row's recipient, amount and narration. The names are
 * left out, as the API leaves them out of its request hash: sending again after checking a changed name must
 * replay a batch that already went, not pay twice. So is the title, which the hash also ignores, so renaming the
 * batch after a send whose answer was lost can't pay the same people again.
 */
export const keyedBody = (branch: string, rows: BulkRow[]) => ({
  branch,
  items: rows.map((r) =>
    r.beneficiary
      ? { beneficiary: r.beneficiary._id, amountKobo: r.amountKobo, narration: r.narration ?? null }
      : { accountNumber: r.accountNumber, bankUuid: r.bank?.uuid, amountKobo: r.amountKobo, narration: r.narration ?? null },
  ),
});

/** What a preview was worked out for: the account and the rows, but not the names (they can be checked again). */
export const previewKey = (from: string | undefined, rows: BulkRow[]) =>
  JSON.stringify([from ?? null, rows.map((r) => [lookupKey(r), r.amountKobo, r.narration ?? null])]);

export const useBulkDraft = create<State & Actions>((set) => ({
  ...blank(),
  open: (business, from) => set((s) => (s.business === business ? { from: s.from ?? from } : blank(business, from))),
  start: (business, from) => set(blank(business, from)),
  set: (d) => set(d),
  addRows: (rows) => set((s) => ({ rows: [...s.rows, ...rows.map((r) => ({ ...r, id: newId() }))] })),
  saveRow: (row) =>
    set((s) => {
      const { [row.id]: _dropped, ...serverErrors } = s.serverErrors;
      const exists = s.rows.some((r) => r.id === row.id);
      return { rows: exists ? s.rows.map((r) => (r.id === row.id ? row : r)) : [...s.rows, row], serverErrors };
    }),
  removeRows: (ids) =>
    set((s) => {
      const drop = new Set(ids);
      const serverErrors = Object.fromEntries(Object.entries(s.serverErrors).filter(([id]) => !drop.has(id)));
      return { rows: s.rows.filter((r) => !drop.has(r.id)), serverErrors };
    }),
  setNames: (names) => set((s) => ({ names: { ...s.names, ...names } })),
  markRenamed: (changes) =>
    set((s) => {
      const names = { ...s.names };
      const renamed = { ...s.renamed };
      let rows = s.rows;
      for (const c of changes) {
        const row = rows.find((r) => r.id === c.id);
        if (!row) continue;
        const key = lookupKey(row);
        if (row.beneficiary) {
          // The name the member saw first stays the one they're told they checked.
          renamed[key] ??= row.beneficiary.accountName;
          const beneficiary = { ...row.beneficiary, accountName: c.accountName };
          rows = rows.map((r) => (r.beneficiary?._id === beneficiary._id ? { ...r, beneficiary } : r));
        } else {
          const was = names[key]?.data;
          if (!was) continue;
          renamed[key] ??= was.accountName;
          names[key] = { data: { ...was, accountName: c.accountName } };
        }
      }
      return { names, renamed, rows };
    }),
  acceptRenamed: () => set({ renamed: {} }),
  setServerErrors: (serverErrors) => set({ serverErrors }),
  editRow: (id) =>
    set((s) => {
      const row = id ? s.rows.find((r) => r.id === id) : undefined;
      if (!row) return { form: blankForm() };
      return {
        form: {
          id: row.id,
          beneficiary: row.beneficiary,
          bank: row.bank,
          bankText: row.bankText,
          bankError: row.bankError,
          accountNumber: row.accountNumber,
          amount: row.amountKobo !== null && row.amountKobo > 0 ? koboToInput(row.amountKobo) : "",
          narration: row.narration ?? "",
        },
      };
    }),
  updateForm: (f) => set((s) => ({ form: { ...s.form, ...f } })),
}));

// Signing out forgets the list, so the next person to sign in on this phone never sees it.
useAuth.subscribe((s, prev) => {
  if (s.status === "signedOut" && prev.status !== "signedOut") useBulkDraft.getState().start();
});
