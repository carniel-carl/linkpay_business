import type { Metadata } from "next"
import { redirect } from "next/navigation"
import { WorkflowEditor } from "@/components/approvals/workflow-editor"
import { PageHeader } from "@/components/common/page-header"
import { TransactionsUnavailable } from "@/components/transactions/transactions-unavailable"
import { getApprovers, getOverview, getTransferSettings } from "@/lib/data"
import { can } from "@/lib/permissions"

export const metadata: Metadata = { title: "Approval levels" }

export default async function ApprovalSetupPage() {
  const overview = await getOverview()
  if (!overview || overview.business.status !== "approved" || !can(overview, "transfers.manage")) redirect("/approvals")

  const [settings, approvers] = await Promise.all([getTransferSettings(), getApprovers()])
  const header = (
    <PageHeader
      back={{ href: "/approvals", label: "Fund approvals" }}
      title="Approval levels"
      description="Choose the amounts that need approval and who approves them, in order. Bigger amounts can go through more people."
    />
  )
  if (!settings.ok || !approvers.ok) {
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
      <WorkflowEditor settings={settings.data} approvers={approvers.data} />
    </>
  )
}
