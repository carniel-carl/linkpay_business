import { create } from "zustand";
import type { PaymentFilters } from "@/lib/api/banking";

export const DEFAULT_FILTERS: PaymentFilters = { period: "month" };

/** The Payments tab's filters. Home's "See all" opens it scoped to a branch and today. */
export const usePaymentFilters = create<{ filters: PaymentFilters; setFilters: (f: Partial<PaymentFilters>) => void; reset: () => void }>(
  (set) => ({
    filters: DEFAULT_FILTERS,
    setFilters: (f) => set((s) => ({ filters: { ...s.filters, ...f } })),
    reset: () => set({ filters: DEFAULT_FILTERS }),
  }),
);
