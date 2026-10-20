import "server-only"
import { api } from "@/lib/api/client"
import { ApiError } from "@/lib/api/errors"
import type { AccountWithBalance } from "@/lib/api/types"

/** What the account screens can be showing. Serialisable, so Server Actions can return it. */
export type AccountsResult =
  | { state: "ready"; accounts: AccountWithBalance[] }
  | { state: "setting_up" }
  | { state: "provider_down" }
  | { state: "not_approved" }
  | { state: "unavailable" }

/**
 * GET /api/accounts (optionally one branch's), mapped to a UI state. Expected failures become
 * states; only an expired session is rethrown so the caller can send the user to sign in.
 */
export async function fetchAccounts(branchId?: string | null): Promise<AccountsResult> {
  const query = branchId ? `?branch=${encodeURIComponent(branchId)}` : ""
  try {
    return { state: "ready", accounts: await api<AccountWithBalance[]>(`/api/accounts${query}`) }
  } catch (err) {
    if (!(err instanceof ApiError)) throw err
    if (err.sessionExpired) throw err
    if (err.code === "ACCOUNT_NOT_READY") return { state: "setting_up" }
    if (err.code === "PROVIDER_ERROR" || err.code === "API_UNREACHABLE" || err.status >= 500) {
      return { state: "provider_down" }
    }
    if (err.code === "BUSINESS_NOT_APPROVED" || err.code === "BUSINESS_REQUIRED") return { state: "not_approved" }
    return { state: "unavailable" }
  }
}
