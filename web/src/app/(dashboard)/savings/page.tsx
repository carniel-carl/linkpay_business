import type { Metadata } from "next"
import { Lock, PiggyBank, Plus } from "lucide-react"
import { PageHeader } from "@/components/common/page-header"
import { FeaturePlaceholder } from "@/components/dashboard/feature-placeholder"
import { PocketFormDialog, type PocketBranch } from "@/components/savings/pocket-form-dialog"
import { SavingsView } from "@/components/savings/savings-view"
import { TransactionsUnavailable } from "@/components/transactions/transactions-unavailable"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { fetchAccounts } from "@/lib/accounts"
import { getOverview, getPocket, getPockets, getSelected } from "@/lib/data"
import { can } from "@/lib/permissions"
import { parseSavingsQuery } from "@/lib/savings"

export const metadata: Metadata = { title: "Savings" }

export default async function SavingsPage({ searchParams }: PageProps<"/savings">) {
  const overview = await getOverview()
  if (!overview || overview.business.status !== "approved") {
    return (
      <FeaturePlaceholder
        title="Savings"
        icon={PiggyBank}
        summary="Set money aside for tax, payroll and rent."
        detail="Keep money for what's coming apart from what you spend, with targets and automatic saving from every payment in."
      />
    )
  }
  if (!can(overview, "accounts.view")) {
    return (
      <>
        <PageHeader title="Savings" description="Money set aside in your accounts." />
        <Empty className="surface min-h-80 border-0 p-10">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Lock aria-hidden />
            </EmptyMedia>
            <EmptyTitle>Savings aren&apos;t part of your role</EmptyTitle>
            <EmptyDescription>Ask the business owner or an admin if you need to see or manage savings.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    )
  }

  const query = parseSavingsQuery(await searchParams)
  const selected = await getSelected()
  const branches = overview.branches ?? []
  const canManage = can(overview, "savings.manage")

  const [active, closed, accounts, linked] = await Promise.all([
    getPockets("active", selected?._id),
    query.status === "closed" ? getPockets("closed", selected?._id) : null,
    fetchAccounts(selected?._id),
    query.pocket ? getPocket(query.pocket) : null,
  ])

  // Branches whose account is open, with what each can still save (available balance).
  const ready: PocketBranch[] =
    accounts.state === "ready"
      ? accounts.accounts.flatMap((a) =>
          typeof a.branch === "object" && a.branch
            ? [{ _id: a.branch._id, name: a.branch.name, availableKobo: a.balance?.availableKobo ?? a.balance?.amountKobo ?? null }]
            : [],
        )
      : []

  const newPocket = canManage && ready.length > 0 && (
    <PocketFormDialog branches={ready} defaultBranchId={selected?._id}>
      <Button>
        <Plus data-icon="inline-start" aria-hidden />
        New pocket
      </Button>
    </PocketFormDialog>
  )

  const header = (
    <PageHeader
      title={selected && branches.length > 1 ? `Savings, ${selected.name}` : "Savings"}
      description={
        <>
          {selected && branches.length > 1 ? `Showing ${selected.name}. ` : ""}
          Set money aside for tax, payroll or rent. It stays in your account, out of what transfers can spend, and comes back
          whenever you need it.
        </>
      }
      actions={newPocket}
    />
  )

  if (!active.ok || (closed && !closed.ok)) {
    return (
      <>
        {header}
        <TransactionsUnavailable />
      </>
    )
  }

  return (
    <>
      {header}
      <SavingsView
        active={active.data}
        closed={closed?.ok ? closed.data.items : null}
        query={query}
        linked={linked?.ok ? linked.data : null}
        branches={ready}
        canManage={canManage}
        showBranch={!selected && branches.length > 1}
        newPocket={newPocket}
      />
    </>
  )
}
