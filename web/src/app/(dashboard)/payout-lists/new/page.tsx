import type { Metadata } from "next"
import { redirect } from "next/navigation"
import { PageHeader } from "@/components/common/page-header"
import { PayoutsLocked } from "@/components/payouts/parts"
import { PayoutListEditor, type ListBranch } from "@/components/payouts/payout-list-editor"
import { getOverview, getSelected } from "@/lib/data"
import { can } from "@/lib/permissions"

export const metadata: Metadata = { title: "New payout list" }

export default async function NewPayoutListPage() {
  const overview = await getOverview()
  if (!overview || overview.business.status !== "approved") redirect("/payout-lists")
  if (!can(overview, "accounts.view")) return <PayoutsLocked title="Payout lists" />
  if (!can(overview, "transfers.create")) redirect("/payout-lists")
  const selected = await getSelected()
  // Branches whose account is open, so a list can pay from them.
  const branches: ListBranch[] = (overview.branches ?? [])
    .filter((b) => b.account)
    .map((b) => ({ _id: b._id, name: b.name, accountNumber: b.account?.accountNumber ?? null }))
  return (
    <>
      <PageHeader
        back={{ href: "/payout-lists", label: "Payout lists" }}
        title="New payout list"
        description="Pick the people this list pays and how much each one gets. Saving it moves no money; you pay it when you're ready, and can change amounts then."
      />
      <PayoutListEditor branches={branches} defaultBranchId={branches.some((b) => b._id === selected?._id) ? selected?._id : undefined} />
    </>
  )
}
