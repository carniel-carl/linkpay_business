import { create } from "zustand";
import { KEYS, secureDelete, secureGet, secureSet } from "@/lib/auth/secure-storage";

/**
 * The business picked in the switcher, sent as X-Business-Id. Unset means the backend's default (the
 * business the user owns, otherwise the one they joined first). Cleared on sign-out.
 */
export const useBusinessContext = create<{ businessId?: string; setBusinessId: (id?: string) => void }>((set) => ({
  businessId: undefined,
  setBusinessId(businessId) {
    set({ businessId });
    void (businessId ? secureSet(KEYS.business, businessId) : secureDelete(KEYS.business)).catch(() => undefined);
  },
}));

export async function loadBusinessId() {
  useBusinessContext.setState({ businessId: (await secureGet(KEYS.business)) ?? undefined });
}

export const currentBusinessId = () => useBusinessContext.getState().businessId;
