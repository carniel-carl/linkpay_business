import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { useBusinessContext } from "@/lib/business-context";
import { api } from "./client";
import type { BeneficiaryList } from "./types";

// /api/beneficiaries (docs/briefs/bulk-payouts.md): the business's saved recipients, name-checked once when saved.
// Mobile only picks from them for now (bulk transfers); adding, renaming and importing stay on the web.

const PAGE = 100;

/** Most recently paid first, then by name. `q` searches the name, nickname, account number and bank. */
export function useBeneficiaries(q?: string) {
  const business = useBusinessContext((s) => s.businessId ?? "default");
  return useInfiniteQuery({
    queryKey: [business, "beneficiaries", q],
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams({ skip: String(pageParam), take: String(PAGE) });
      if (q) params.set("q", q);
      return api<BeneficiaryList>(`/api/beneficiaries?${params}`, { signal });
    },
    initialPageParam: 0,
    getNextPageParam: (last) => (last.skip + last.items.length < last.total ? last.skip + last.items.length : undefined),
    placeholderData: keepPreviousData,
  });
}
