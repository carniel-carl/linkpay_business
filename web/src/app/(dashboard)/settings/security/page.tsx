import type { Metadata } from "next"
import { PasswordSettings } from "@/components/settings/password-settings"
import { SecuritySettings } from "@/components/settings/security-settings"
import { SignedInSessions, type SignedInSession } from "@/components/settings/signed-in-sessions"
import { TransactionPinSettings } from "@/components/settings/transaction-pin-settings"
import { api } from "@/lib/api/client"
import type { TransactionPinStatus } from "@/lib/api/types"
import { getMe } from "@/lib/data"
import { timeAgo } from "@/lib/format"

export const metadata: Metadata = { title: "Security" }

export default async function SecurityPage() {
  const [user, sessions, pin] = await Promise.all([
    getMe(),
    // The two-step settings don't depend on this; without it the list is left out.
    api<SignedInSession[]>("/api/auth/sessions").catch(() => null),
    // Without it the PIN section says it couldn't check.
    api<TransactionPinStatus>("/api/transaction-pin").catch(() => null),
  ])
  return (
    <div className="grid gap-10">
      <PasswordSettings hasPassword={user.hasPassword !== false} email={user.email} />
      <TransactionPinSettings status={pin} hasPassword={user.hasPassword !== false} />
      <SecuritySettings
        enabled={!!user.twoFactor?.enabled}
        method={user.twoFactor?.method ?? null}
        email={user.email}
        recoveryCodesLeft={user.twoFactor?.recoveryCodesLeft ?? 0}
        hasPassword={user.hasPassword !== false}
      />
      {sessions && (
        <SignedInSessions
          sessions={sessions.map((s) => ({ ...s, lastActive: s.current ? "Active now" : `Last active ${timeAgo(s.lastUsedAt)}` }))}
        />
      )}
    </div>
  )
}
