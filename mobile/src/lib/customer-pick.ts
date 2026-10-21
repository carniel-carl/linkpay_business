import { create } from "zustand";
import type { InvoiceCustomer } from "@/lib/api/types";

/**
 * The customer picker's answer, handed back to the invoice form underneath it: a saved customer, or "new" to
 * type one in. The form takes it once and clears it. Memory only.
 */
export const useCustomerPick = create<{
  pick?: InvoiceCustomer | "new";
  set: (pick: InvoiceCustomer | "new") => void;
  clear: () => void;
}>((set) => ({
  pick: undefined,
  set: (pick) => set({ pick }),
  clear: () => set({ pick: undefined }),
}));
