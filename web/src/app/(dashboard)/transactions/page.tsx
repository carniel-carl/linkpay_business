import type { Metadata } from "next"
import { History, Lock } from "lucide-react"
import { PageHeader } from "@/components/common/page-header"
import { FeaturePlaceholder } from "@/components/dashboard/feature-placeholder"
import { TransactionsUnavailable } from "@/components/transactions/transactions-unavailable"
import { TransactionsView } from "@/components/transactions/transactions-view"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { getOverview, getSelected, getTransactions, getTransactionSummary } from "@/lib/data"
import { can } from "@/lib/permissions"
import { hasFilters, parseTransactionQuery, summaryParams, toApiParams } from "@/lib/transactions"

export const metadata: Metadata = { title: "Transactions" }

const branchIdOf = (b: unknown) => (typeof b === "string" ? b : (b as { _id?: string } | undefined)?._id)

export default async function TransactionsPage({ searchParams }: PageProps<"/transactions">) {
  const overview = await getOverview()
  if (!overview || overview.business.status !== "approved") {
    return (
      <FeaturePlaceholder
        title="Transactions"
        icon={History}
        summary="Every payment into and out of your accounts."
        detail="Payments you receive show here as soon as they arrive."
      />
    )
  }
  if (!can(overview, "accounts.view")) {
    return (
      <>
        <PageHeader title="Transactions" description="Every payment into and out of your accounts." />
        <Empty className="surface min-h-80 border-0 p-10">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Lock aria-hidden />
            </EmptyMedia>
            <EmptyTitle>Transactions aren&apos;t part of your role</EmptyTitle>
            <EmptyDescription>Ask the business owner or an admin if you need to see payments.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    )
  }

  const query = parseTransactionQuery(await searchParams)
  const selected = await getSelected()
  const branches = overview.branches ?? []
  // A branch in the URL ("View transactions" on Accounts) wins over the sidebar's choice.
  const urlBranch = query.branch ? branches.find((b) => b._id === query.branch) : undefined
  const branch = urlBranch ?? selected ?? (branches.length === 1 ? branches[0] : undefined)
  const now = new Date()

  const [list, summary] = await Promise.all([
    getTransactions(toApiParams(query, branch?._id, now)),
    getTransactionSummary(summaryParams(query, branch?._id, now)),
  ])

  const title = branch && branches.length > 1 ? `Transactions, ${branch.name}` : "Transactions"
  const header = (
    <PageHeader
      title={title}
      description={
        branch && branches.length > 1
          ? "Money into and out of this branch's account. Switch to All branches in the sidebar to see every account."
          : "Money into and out of your accounts, as soon as our banking partner reports it."
      }
    />
  )
  if (!list.ok) {
    return (
      <>
        {header}
        <TransactionsUnavailable />
      </>
    )
  }

  // Empty with no filters: has there ever been a payment, or only none in this period?
  let empty: "none" | "filtered" = "filtered"
  if (list.data.total === 0 && !hasFilters(query)) {
    if (query.period === "all") empty = "none"
    else {
      const ever = await getTransactions(toApiParams({ ...query, period: "all", page: 1, size: 1 }, branch?._id, now))
      if (ever.ok && ever.data.total === 0) empty = "none"
    }
  }
  const accounts = overview.accounts ?? []
  const shareAccount =
    accounts.find((a) => branchIdOf(a.branch) === (branch ?? branches.find((b) => b.isHeadOffice))?._id) ?? accounts[0]

  return (
    <>
      {header}
      <TransactionsView
        data={list.data}
        summary={summary.ok ? summary.data : null}
        query={query}
        showBranch={!branch && branches.length > 1}
        branchChip={urlBranch && urlBranch._id !== selected?._id ? urlBranch.name : undefined}
        empty={empty}
        shareAccount={shareAccount}
      />
    </>
  )
}
