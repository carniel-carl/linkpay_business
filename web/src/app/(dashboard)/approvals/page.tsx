import type { Metadata } from "next"
import Link from "next/link"
import { Lock, Settings2, ShieldCheck } from "lucide-react"
import { ApprovalsView } from "@/components/approvals/approvals-view"
import { WorkflowSummary } from "@/components/approvals/workflow-summary"
import { PageHeader } from "@/components/common/page-header"
import { FeaturePlaceholder } from "@/components/dashboard/feature-placeholder"
import { WriteGate } from "@/components/shell/write-gate"
import { TransactionsUnavailable } from "@/components/transactions/transactions-unavailable"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { parseApprovalQuery, toApprovalApiParams } from "@/lib/approvals"
import {
  getAwaitingApprovalCount,
  getOverview,
  getPendingApprovalCount,
  getSelected,
  getTransfer,
  getTransferBatches,
  getTransfers,
  getTransferSettings,
} from "@/lib/data"
import { can } from "@/lib/permissions"
import { describeApprovalRule } from "@/lib/transfers"

export const metadata: Metadata = { title: "Fund approvals" }

export default async function ApprovalsPage({ searchParams }: PageProps<"/approvals">) {
  const overview = await getOverview()
  if (!overview || overview.business.status !== "approved") {
    return (
      <FeaturePlaceholder
        title="Fund approvals"
        icon={ShieldCheck}
        summary="Decide who approves money leaving the business."
        detail="Set approval levels by amount, name the approvers at each level, and follow every transfer until it's approved or declined."
      />
    )
  }
  if (!can(overview, "accounts.view")) {
    return (
      <>
        <PageHeader title="Fund approvals" description="Transfers that need someone's approval before money leaves." />
        <Empty className="surface min-h-80 border-0 p-10">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Lock aria-hidden />
            </EmptyMedia>
            <EmptyTitle>Approvals aren&apos;t part of your role</EmptyTitle>
            <EmptyDescription>Ask the business owner or an admin if you need to see or approve payments.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    )
  }

  const query = parseApprovalQuery(await searchParams)
  const selected = await getSelected()
  const branches = overview.branches ?? []
  const canApprove = can(overview, "transfers.approve")
  const canManage = can(overview, "transfers.manage")

  // Bulk transfers with rows waiting for this member, newest first, to decide as a whole.
  const batchParams = new URLSearchParams({ awaiting: "me", take: "10" })
  if (selected) batchParams.set("branch", selected._id)

  const [list, pendingCount, awaitingCount, settings, linked, batches] = await Promise.all([
    getTransfers(toApprovalApiParams(query, selected?._id)),
    getPendingApprovalCount(),
    canApprove ? getAwaitingApprovalCount() : Promise.resolve(0),
    getTransferSettings(),
    query.transfer ? getTransfer(query.transfer) : null,
    canApprove ? getTransferBatches(batchParams) : null,
  ])
  const workflow = settings.ok && settings.data.approval.mode === "workflow"

  const header = (
    <PageHeader
      title="Fund approvals"
      description={
        <>
          {selected && branches.length > 1 ? `Showing ${selected.name}. ` : ""}
          {settings.ok ? describeApprovalRule(settings.data) : "Transfers that need someone's approval before money leaves."}
        </>
      }
      actions={
        canManage && (
          // Disabled, with the reason, while the business is suspended.
          <WriteGate>
            <Button asChild variant={workflow ? "outline" : "default"}>
              <Link href="/approvals/setup">
                <Settings2 data-icon="inline-start" aria-hidden />
                {workflow ? "Edit approval levels" : "Set up approvals"}
              </Link>
            </Button>
          </WriteGate>
        )
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
      <div className="grid gap-6">
        <ApprovalsView
          data={list.data}
          query={query}
          pendingCount={pendingCount}
          awaitingCount={canApprove ? awaitingCount : null}
          showBranch={!selected && branches.length > 1}
          linked={linked?.ok ? linked.data : null}
          batches={batches?.ok ? batches.data : null}
        />
        {settings.ok && <WorkflowSummary settings={settings.data} canManage={canManage} />}
      </div>
    </>
  )
}
