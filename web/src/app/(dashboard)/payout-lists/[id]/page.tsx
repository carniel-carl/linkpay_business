import type { Metadata } from "next"
import Link from "next/link"
import { notFound, redirect } from "next/navigation"
import { Pencil } from "lucide-react"
import { PageHeader } from "@/components/common/page-header"
import { PayoutsLocked } from "@/components/payouts/parts"
import { PayoutListMenu } from "@/components/payouts/payout-list-actions"
import { PayoutListRun } from "@/components/payouts/payout-list-run"
import type { SourceAccount } from "@/components/transfers/new-transfer-dialog"
import { Button } from "@/components/ui/button"
import { fetchAccounts } from "@/lib/accounts"
import { getOverview, getPayoutList, getSelected } from "@/lib/data"
import { formatDate, formatNaira } from "@/lib/format"
import { people } from "@/lib/payouts"
import { can } from "@/lib/permissions"

export const metadata: Metadata = { title: "Payout list" }

const ACCOUNTS_NOTE = {
  setting_up: "Your accounts are still being set up, so this list can't be paid yet.",
  provider_down: "We can't reach your accounts right now, so this list can't be paid. Try again in a moment.",
  not_approved: "This list can be paid once your business is verified.",
  unavailable: "Your accounts can't be loaded right now, so this list can't be paid.",
} as const

export default async function PayoutListPage({ params }: PageProps<"/payout-lists/[id]">) {
  const { id } = await params
  const overview = await getOverview()
  if (!overview || overview.business.status !== "approved") redirect("/payout-lists")
  if (!can(overview, "accounts.view")) return <PayoutsLocked title="Payout lists" />

  // Paying, editing and deleting need the right to prepare transfers; others see the list read-only.
  const canRun = can(overview, "transfers.create")
  const [list, accounts, selected] = await Promise.all([getPayoutList(id), canRun ? fetchAccounts() : null, getSelected()])
  if (!list) notFound()

  // Accounts the member can pay from: their branches', with balances.
  const sources: SourceAccount[] =
    accounts?.state === "ready" ? accounts.accounts.filter((a): a is SourceAccount => typeof a.branch === "object" && !!a.branch) : []
  const note = accounts && accounts.state !== "ready" ? ACCOUNTS_NOTE[accounts.state] : undefined
  // The list's own account, else the sidebar's branch, else the only one there is.
  const defaultBranchId = [list.branch?._id, selected?._id, sources.length === 1 ? sources[0].branch._id : undefined].find(
    (b) => b && sources.some((s) => s.branch._id === b),
  )

  return (
    <>
      <PageHeader
        back={{ href: "/payout-lists", label: "Payout lists" }}
        title={list.title}
        description={
          <>
            {people(list.count)}, <span className="figure">{formatNaira(list.amountKobo)}</span> before fees.{" "}
            {list.branch ? `Pays from ${list.branch.name}.` : "No default account."}{" "}
            {list.lastRunAt ? (
              <>
                Last paid{" "}
                {list.lastBatch || list.lastTransfer ? (
                  <Link
                    href={list.lastBatch ? `/transfers?batch=${list.lastBatch}` : `/transfers?transfer=${list.lastTransfer}`}
                    className="underline underline-offset-4 hover:text-brand-surface-foreground"
                  >
                    {formatDate(list.lastRunAt)}
                  </Link>
                ) : (
                  formatDate(list.lastRunAt)
                )}
                .
              </>
            ) : (
              "Not paid yet."
            )}
          </>
        }
        actions={
          canRun && (
            <>
              <Button variant="outline" asChild>
                <Link href={`/payout-lists/${list._id}/edit`}>
                  <Pencil data-icon="inline-start" aria-hidden />
                  Edit list
                </Link>
              </Button>
              <PayoutListMenu list={list} leaveTo="/payout-lists" showEdit={false} />
            </>
          )
        }
      />
      <PayoutListRun list={list} accounts={sources} defaultBranchId={defaultBranchId} canRun={canRun} accountsNote={note} />
    </>
  )
}
