import type { Metadata } from "next"
import { ArrowLeftRight, Lock, Plus, Rows3 } from "lucide-react"
import { PageHeader } from "@/components/common/page-header"
import { FeaturePlaceholder } from "@/components/dashboard/feature-placeholder"
import { ApprovalRuleDialog } from "@/components/transfers/approval-rule-dialog"
import { BulkTransferDialog } from "@/components/transfers/bulk-transfer-dialog"
import { NewTransferDialog, type SourceAccount } from "@/components/transfers/new-transfer-dialog"
import { BatchListAction } from "@/components/payouts/save-batch-as-list"
import { TransfersView } from "@/components/transfers/transfers-view"
import { WriteGate } from "@/components/shell/write-gate"
import { TransactionsUnavailable } from "@/components/transactions/transactions-unavailable"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { fetchAccounts } from "@/lib/accounts"
import {
  getAwaitingApprovalCount,
  getOverview,
  getSelected,
  getTransfer,
  getTransferBatch,
  getTransfers,
  getTransferSettings,
} from "@/lib/data"
import { can } from "@/lib/permissions"
import { describeApprovalRule, parseTransferQuery, toApiParams } from "@/lib/transfers"

export const metadata: Metadata = { title: "Transfers" }

export default async function TransfersPage({ searchParams }: PageProps<"/transfers">) {
  const overview = await getOverview()
  if (!overview || overview.business.status !== "approved") {
    return (
      <FeaturePlaceholder
        title="Transfers"
        icon={ArrowLeftRight}
        summary="Send money to any Nigerian bank account."
        detail="Single and bulk transfers to any Nigerian bank, with approval rules for large payments."
      />
    )
  }
  if (!can(overview, "accounts.view")) {
    return (
      <>
        <PageHeader title="Transfers" description="Money sent from your accounts." />
        <Empty className="surface min-h-80 border-0 p-10">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Lock aria-hidden />
            </EmptyMedia>
            <EmptyTitle>Transfers aren&apos;t part of your role</EmptyTitle>
            <EmptyDescription>Ask the business owner or an admin if you need to send or approve payments.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    )
  }

  const query = parseTransferQuery(await searchParams)
  const selected = await getSelected()
  const branches = overview.branches ?? []
  const canCreate = can(overview, "transfers.create")
  const canApprove = can(overview, "transfers.approve")

  const [list, awaitingCount, settings, batch, linked, accounts] = await Promise.all([
    getTransfers(toApiParams(query, query.batch ? undefined : selected?._id)),
    canApprove ? getAwaitingApprovalCount() : Promise.resolve(0),
    getTransferSettings(),
    query.batch ? getTransferBatch(query.batch) : null,
    query.transfer ? getTransfer(query.transfer) : null,
    canCreate ? fetchAccounts() : null,
  ])

  // Accounts the member can send from: their branches', with balances.
  const sources: SourceAccount[] =
    accounts?.state === "ready"
      ? accounts.accounts.filter((a): a is SourceAccount => typeof a.branch === "object" && !!a.branch)
      : []
  // The sidebar's branch, if its account can send: one that isn't ready isn't among the sources.
  const defaultBranchId = selected && sources.some((s) => s.branch._id === selected._id) ? selected._id : undefined

  // While the business is suspended these show disabled, with the reason (WriteGate).
  const actions = canCreate && sources.length > 0 && (
    <WriteGate>
      <BulkTransferDialog accounts={sources} defaultBranchId={defaultBranchId}>
        {/* Icons only on phones, like the approval rule's, so the header's buttons fit beside each other. `px-0!`
            beats the button's own padding beside an icon, so the icon sits in the middle. */}
        <Button variant="outline" className="max-sm:w-9 max-sm:px-0!">
          <Rows3 data-icon="inline-start" aria-hidden />
          <span className="max-sm:sr-only">Bulk transfer</span>
        </Button>
      </BulkTransferDialog>
      <NewTransferDialog accounts={sources} defaultBranchId={defaultBranchId}>
        <Button>
          <Plus data-icon="inline-start" aria-hidden />
          New transfer
        </Button>
      </NewTransferDialog>
    </WriteGate>
  )

  const branchNote = selected && branches.length > 1 ? `Showing ${selected.name}. ` : ""
  const header = (
    <PageHeader
      title={selected && branches.length > 1 ? `Transfers, ${selected.name}` : "Transfers"}
      description={
        <>
          {branchNote}
          {settings.ok ? describeApprovalRule(settings.data) : "Send money to any Nigerian bank account, or between your branches."}
        </>
      }
      actions={
        <>
          {/* Its trigger is gated (Button `write`) while the business is suspended. */}
          {can(overview, "transfers.manage") && settings.ok && <ApprovalRuleDialog settings={settings.data} />}
          {actions}
        </>
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

  return (
    <>
      {header}
      <TransfersView
        data={list.data}
        query={query}
        canApprove={canApprove}
        awaitingCount={awaitingCount}
        showBranch={!selected && branches.length > 1}
        batch={batch?.ok ? batch.data : null}
        linked={linked?.ok ? linked.data : null}
        batchAction={canCreate && batch?.ok ? <BatchListAction batch={batch.data} /> : undefined}
        newTransfer={
          canCreate &&
          sources.length > 0 && (
            <WriteGate>
              <NewTransferDialog accounts={sources} defaultBranchId={defaultBranchId}>
                <Button>
                  <Plus data-icon="inline-start" aria-hidden />
                  New transfer
                </Button>
              </NewTransferDialog>
            </WriteGate>
          )
        }
      />
    </>
  )
}
