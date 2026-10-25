import { create } from "zustand";
import { idempotencyKeys } from "@/lib/api/client";
import type { Bank, ResolvedAccount } from "@/lib/api/types";
import { useAuth } from "@/lib/auth/store";
import { useBusinessContext } from "@/lib/business-context";

/** A transfer being prepared, shared by the send form, the bank picker and the review. Memory only. */
export type SendDraft = {
  /** Branch whose account the money leaves. */
  from?: string;
  to: "bank" | "branch";
  bank?: Bank;
  accountNumber: string;
  /**
   * The name enquiry the user saw, and the bank it was for; the review shows exactly this, and sends only if it's
   * still for `accountNumber` and `bank`.
   */
  resolved?: ResolvedAccount & { bankUuid: string };
  toBranch?: string;
  /** As typed, e.g. "25,000.50". */
  amount: string;
  narration: string;
  /**
   * The Idempotency-Key for a send, by what's sent (everything the API's request hash covers: the account it
   * leaves, where it goes, the amount and the narration). Sending the same transfer again (after a dropped
   * connection, a wrong PIN, Edit and Continue, or closing Send money and filling it in again) reuses its key,
   * so it can't pay twice. New only after a transfer went, or the key was refused for other details.
   */
  keyFor: (body: unknown) => string;
};

const blank = (keyFor = idempotencyKeys()): SendDraft => ({ to: "bank", accountNumber: "", amount: "", narration: "", keyFor });

type Actions = {
  update: (d: Partial<SendDraft>) => void;
  /** Opening Send money: blank details, the same keys (a transfer whose answer was lost, filled in again, keeps its key). */
  start: (from?: string) => void;
  /** After IDEMPOTENCY_KEY_REUSED (the key went with other details): a deliberate retry is a new request. */
  freshKeys: () => void;
  /** After a transfer went, and on signing out: a fresh draft with its own keys. */
  finish: () => void;
};

export const useSendDraft = create<{ draft: SendDraft } & Actions>((set) => ({
  draft: blank(),
  update: (d) => set((s) => ({ draft: { ...s.draft, ...d } })),
  start: (from) => set((s) => ({ draft: { ...blank(s.draft.keyFor), from } })),
  freshKeys: () => set((s) => ({ draft: { ...s.draft, keyFor: idempotencyKeys() } })),
  finish: () => set({ draft: blank() }),
}));

// Signing out forgets the transfer, so the next person to sign in on this phone never sees it. Switching business
// clears the details, which name the last business's account; the keys stay, as what they're for names it too.
useAuth.subscribe((s, prev) => {
  if (s.status === "signedOut" && prev.status !== "signedOut") useSendDraft.getState().finish();
});
useBusinessContext.subscribe((s, prev) => {
  if (s.businessId !== prev.businessId) useSendDraft.getState().start();
});

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
