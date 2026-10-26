import type { Metadata } from "next"
import { MoneyProtectionView } from "@/components/money-protection/money-protection-view"
import type { SourceAccount } from "@/components/transfers/new-transfer-dialog"
import { TransactionsUnavailable } from "@/components/transactions/transactions-unavailable"
import { fetchAccounts } from "@/lib/accounts"
import { getOverview, getSecurity, getSecurityEvents, getSettlementAccounts } from "@/lib/data"
import { can } from "@/lib/permissions"

export const metadata: Metadata = { title: "Money protection" }

/** Settlement accounts, withdrawals, "settlement accounts only", the emergency freeze and security activity. */
export default async function MoneyProtectionPage() {
  const overview = await getOverview()
  if (!overview || overview.business.status !== "approved") {
    return <p className="text-sm text-muted-foreground">Money protection is available once your business is verified.</p>
  }
  const canWithdraw = can(overview, "transfers.create")
  const [security, accounts, events, balances] = await Promise.all([
    getSecurity(),
    getSettlementAccounts(),
    can(overview, "team.manage") ? getSecurityEvents() : null,
    canWithdraw ? fetchAccounts() : null,
  ])
  if (!security.ok || !accounts.ok) return <TransactionsUnavailable />

  const sources: SourceAccount[] =
    balances?.state === "ready" ? balances.accounts.filter((a): a is SourceAccount => typeof a.branch === "object" && !!a.branch) : []

  return (
    <MoneyProtectionView
      security={security.data}
      accounts={accounts.data.items}
      events={events?.ok ? events.data.items : null}
      sources={sources}
      canManage={can(overview, "settlement.manage")}
      canFreeze={can(overview, "security.freeze")}
    />
  )
}
