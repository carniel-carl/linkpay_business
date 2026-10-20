"use server"

import { redirect } from "next/navigation"
import { fetchAccounts, type AccountsResult } from "@/lib/accounts"
import { ApiError } from "@/lib/api/errors"
import { getSelected } from "@/lib/data"
import { clearSession } from "@/lib/session"

/** Re-fetches accounts and balances for the selected branch (polling while setting up, and the retry buttons). */
export async function loadAccounts(): Promise<AccountsResult> {
  try {
    return await fetchAccounts((await getSelected())?._id)
  } catch (err) {
    if (err instanceof ApiError && err.sessionExpired) {
      await clearSession()
      redirect("/sign-in?expired=1")
    }
    throw err
  }
}
