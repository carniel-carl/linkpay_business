import type { Metadata } from "next"
import { PasswordSettings } from "@/components/settings/password-settings"
import { SecuritySettings } from "@/components/settings/security-settings"
import { SignedInSessions, type SignedInSession } from "@/components/settings/signed-in-sessions"
import { api } from "@/lib/api/client"
import { getMe } from "@/lib/data"
import { timeAgo } from "@/lib/format"

export const metadata: Metadata = { title: "Security" }

export default async function SecurityPage() {
  const [user, sessions] = await Promise.all([
    getMe(),
    // The two-step settings don't depend on this; without it the list is left out.
    api<SignedInSession[]>("/api/auth/sessions").catch(() => null),
  ])
  return (
    <div className="grid gap-10">
      <PasswordSettings hasPassword={user.hasPassword !== false} email={user.email} />
      <SecuritySettings enabled={!!user.twoFactor?.enabled} method={user.twoFactor?.method ?? null} email={user.email} />
      {sessions && (
        <SignedInSessions
          sessions={sessions.map((s) => ({ ...s, lastActive: s.current ? "Active now" : `Last active ${timeAgo(s.lastUsedAt)}` }))}
        />
      )}
    </div>
  )
}
