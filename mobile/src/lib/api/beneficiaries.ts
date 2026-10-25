import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { useBusinessContext } from "@/lib/business-context";
import { api } from "./client";
import { ApiError } from "./errors";
import { idSegment } from "./paths";
import type { Beneficiary, BeneficiaryList } from "./types";

// /api/beneficiaries (docs/briefs/bulk-payouts.md): the business's saved recipients, name-checked once when saved.
// Mobile picks from them (bulk transfers, payout lists) and adds one while building a payout list; renaming,
// deleting and importing stay on the web.

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

/**
 * Saves an account for the whole team (transfers.create, no PIN). The API checks it with the bank again and keeps
 * the name the bank gives. An account that's already saved (BENEFICIARY_EXISTS) comes back as that beneficiary,
 * with `existed`, as on the web.
 */
export async function saveBeneficiary(body: { accountNumber: string; bankUuid: string; nickname?: string }) {
  try {
    return { beneficiary: await api<Beneficiary>("/api/beneficiaries", { method: "POST", json: body }), existed: false };
  } catch (err) {
    const existing = err instanceof ApiError && err.code === "BENEFICIARY_EXISTS" ? (err.details as { beneficiaryId?: unknown } | undefined)?.beneficiaryId : undefined;
    if (typeof existing !== "string") throw err;
    return { beneficiary: await api<Beneficiary>(`/api/beneficiaries/${idSegment(existing)}`), existed: true };
  }
}
