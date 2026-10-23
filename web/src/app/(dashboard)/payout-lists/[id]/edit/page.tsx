import type { Metadata } from "next"
import { notFound, redirect } from "next/navigation"
import { PageHeader } from "@/components/common/page-header"
import { PayoutsLocked } from "@/components/payouts/parts"
import { PayoutListEditor, type ListBranch } from "@/components/payouts/payout-list-editor"
import { getOverview, getPayoutList } from "@/lib/data"
import { can } from "@/lib/permissions"

export const metadata: Metadata = { title: "Edit payout list" }

export default async function EditPayoutListPage({ params }: PageProps<"/payout-lists/[id]/edit">) {
  const { id } = await params
  const overview = await getOverview()
  if (!overview || overview.business.status !== "approved") redirect("/payout-lists")
  if (!can(overview, "accounts.view")) return <PayoutsLocked title="Payout lists" />
  const list = await getPayoutList(id)
  if (!list) notFound()
  if (!can(overview, "transfers.create")) redirect(`/payout-lists/${list._id}`)
  const branches: ListBranch[] = (overview.branches ?? [])
    .filter((b) => b.account)
    .map((b) => ({ _id: b._id, name: b.name, accountNumber: b.account?.accountNumber ?? null }))
  return (
    <>
      <PageHeader
        back={{ href: `/payout-lists/${list._id}`, label: list.title }}
        title="Edit payout list"
        description="Changes apply the next time it's paid. Payments already made from it don't change."
      />
      <PayoutListEditor list={list} branches={branches} />
    </>
  )
}
