"use server"

import { redirect } from "next/navigation"
import { runAction } from "@/lib/action"
import { api } from "@/lib/api/client"
import type { StaffChallenge } from "@/lib/api/types"
import type { ActionResult } from "@/lib/action-result"
import { clearSession, getSessionToken, setChallenge } from "@/lib/session"
import { acceptInviteSchema } from "@/lib/schemas"

/**
 * Creates the staff account from the invite. The backend answers like POST /login (an email code is
 * on its way), so this continues at the normal two-step page.
 */
export async function acceptInvite(token: string, email: string, input: unknown): Promise<ActionResult> {
  const { name, password } = acceptInviteSchema.parse(input)
  const result = await runAction(() =>
    api<StaffChallenge>(`/api/admin/auth/invites/${encodeURIComponent(token)}/accept`, {
      method: "POST",
      json: { name, password },
      auth: false,
    }),
  )
  if (!result.ok) return result
  await setChallenge({ token: result.data.challengeToken, method: result.data.method, email })
  redirect("/sign-in/two-factor")
}

/** Ends the current staff session (on the server too), then reopens the invite signed out. */
export async function signOutForInvite(token: string) {
  if (await getSessionToken()) await api("/api/admin/auth/logout", { method: "POST" }).catch(() => {})
  await clearSession()
  redirect(`/invite/${encodeURIComponent(token)}`)
}
