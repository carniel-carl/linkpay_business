"use server"

import { redirect } from "next/navigation"
import { runAction } from "@/lib/action"
import type { ActionResult } from "@/lib/action-result"
import { api } from "@/lib/api/client"
import type { InviteAccepted, User } from "@/lib/api/types"
import { setBusinessCookie } from "@/lib/business-context"
import { clearSession, getSessionToken, setSession } from "@/lib/session"
import { inviteRegisterSchema } from "@/lib/schemas"

const path = (token: string) => `/api/invites/${encodeURIComponent(token)}`
const invitePage = (token: string) => `/invite/${encodeURIComponent(token)}`

/** Signed in with the invited email: join, then open the dashboard in that business. */
export async function acceptInvite(token: string): Promise<ActionResult> {
  const result = await runAction(() => api<InviteAccepted>(`${path(token)}/accept`, { method: "POST" }))
  if (!result.ok) return { ok: false, error: result.error, code: result.code }
  await setBusinessCookie(result.data.business._id)
  redirect("/dashboard")
}

/** New person: the backend creates the account already verified (the emailed link proves the address) and signs them in. */
export async function registerFromInvite(token: string, input: unknown): Promise<ActionResult> {
  const body = inviteRegisterSchema.parse(input)
  const result = await runAction(() =>
    api<InviteAccepted & { accessToken: string; user: User }>(`${path(token)}/register`, {
      method: "POST",
      json: body,
      auth: false,
    }),
  )
  if (!result.ok) return result
  await setSession(result.data.accessToken)
  await setBusinessCookie(result.data.business._id)
  redirect("/dashboard")
}

/**
 * Signed in as someone else: sign out, then sign in (or sign up) as the invited email and come back here.
 * Sign-in fills in the invited email from the invite in `next`.
 */
export async function switchAccount(token: string, accountExists: boolean) {
  // Ends the session on the server too, like signing out: clearing the cookie alone would leave it valid.
  if (await getSessionToken()) await api("/api/auth/logout", { method: "POST" }).catch(() => {})
  await clearSession()
  if (!accountExists) redirect(invitePage(token))
  redirect(`/sign-in?next=${encodeURIComponent(invitePage(token))}`)
}
