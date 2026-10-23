import { create } from "zustand";
import { idempotencyKeys } from "@/lib/api/client";
import type { Bank, ResolvedAccount } from "@/lib/api/types";

/** A transfer being prepared, shared by the send form, the bank picker and the review. Memory only. */
export type SendDraft = {
  /** Branch whose account the money leaves. */
  from?: string;
  to: "bank" | "branch";
  bank?: Bank;
  accountNumber: string;
  /** The name enquiry result the user saw; the review shows exactly this. */
  resolved?: ResolvedAccount;
  toBranch?: string;
  /** As typed, e.g. "25,000.50". */
  amount: string;
  narration: string;
  /**
   * The Idempotency-Key for a send, by what's sent: sending the same transfer again from this draft (after a
   * dropped connection, or Edit and Continue with nothing changed) reuses its key, so it can't pay twice.
   */
  keyFor: (body: unknown) => string;
};

const blank = (): SendDraft => ({ to: "bank", accountNumber: "", amount: "", narration: "", keyFor: idempotencyKeys() });

export const useSendDraft = create<{ draft: SendDraft; update: (d: Partial<SendDraft>) => void; start: (from?: string) => void }>((set) => ({
  draft: blank(),
  update: (d) => set((s) => ({ draft: { ...s.draft, ...d } })),
  // A new transfer (and after one is sent): a fresh draft, with its own keys.
  start: (from) => set({ draft: { ...blank(), from } }),
}));

/** "25,000.50" -> 2500050. Integer arithmetic only; undefined if it isn't a naira amount with at most 2 decimals. */
export function parseNaira(text: string) {
  const clean = text.replace(/[,\s₦]/g, "");
  const m = /^(\d{1,9})(?:\.(\d{0,2}))?$/.exec(clean);
  if (!m) return undefined;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

/**
 * What a naira field shows while typing: "2000000.5" -> "2,000,000.5". Keeps digits and the first
 * point, at most 9 naira digits and 2 kobo digits, so the result always parses with parseNaira.
 */
export function formatNairaInput(text: string) {
  const clean = text.replace(/[^\d.]/g, "");
  const dot = clean.indexOf(".");
  const whole = (dot < 0 ? clean : clean.slice(0, dot)).replace(/^0+(?=\d)/, "").slice(0, 9);
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (dot < 0) return grouped;
  return `${grouped || "0"}.${clean.slice(dot + 1).replace(/\./g, "").slice(0, 2)}`;
}
