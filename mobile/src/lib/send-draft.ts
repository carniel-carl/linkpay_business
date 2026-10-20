import * as Crypto from "expo-crypto";
import { create } from "zustand";
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
  /** One per review, so a retried send after a dropped connection can't pay twice. */
  idempotencyKey: string;
};

const blank = (): SendDraft => ({ to: "bank", accountNumber: "", amount: "", narration: "", idempotencyKey: Crypto.randomUUID() });

export const useSendDraft = create<{ draft: SendDraft; update: (d: Partial<SendDraft>) => void; start: (from?: string) => void }>((set) => ({
  draft: blank(),
  // Any change to what's being sent means a new send, so a new key.
  update: (d) => set((s) => ({ draft: { ...s.draft, ...d, idempotencyKey: Crypto.randomUUID() } })),
  start: (from) => set({ draft: { ...blank(), from } }),
}));

/** "25,000.50" -> 2500050. Integer arithmetic only; undefined if it isn't a naira amount with at most 2 decimals. */
export function parseNaira(text: string) {
  const clean = text.replace(/[,\s₦]/g, "");
  const m = /^(\d{1,9})(?:\.(\d{0,2}))?$/.exec(clean);
  if (!m) return undefined;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}
