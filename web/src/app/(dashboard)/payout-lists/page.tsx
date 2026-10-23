import type { Metadata } from "next"
import Link from "next/link"
import { BookUser, ListChecks, Plus } from "lucide-react"
import { PageHeader } from "@/components/common/page-header"
import { FeaturePlaceholder } from "@/components/dashboard/feature-placeholder"
import { PayoutsLocked } from "@/components/payouts/parts"
import { PayoutListsView } from "@/components/payouts/payout-lists-view"
import { PayoutsUnavailable } from "@/components/payouts/unavailable"
import { Button } from "@/components/ui/button"
import { getOverview, getPayoutLists, getSelected } from "@/lib/data"
import { can } from "@/lib/permissions"

export const metadata: Metadata = { title: "Payout lists" }

export default async function PayoutListsPage() {
  const overview = await getOverview()
  if (!overview || overview.business.status !== "approved") {
    return (
      <FeaturePlaceholder
        title="Payout lists"
        icon={ListChecks}
        summary="Pay the same people again in a few clicks."
        detail="Save salaries or regular suppliers as a list, then pay everyone on it at once, with your approval rules."
      />
    )
  }
  if (!can(overview, "accounts.view")) return <PayoutsLocked title="Payout lists" />

  const [lists, selected] = await Promise.all([getPayoutLists(), getSelected()])
  const branches = overview.branches ?? []
  const canManage = can(overview, "transfers.create")
  const narrowed = !!selected && branches.length > 1
  const all = lists.ok ? lists.data.items : []
  // The sidebar's branch: lists that pay from it, and those with no default account (they can pay from any).
  const shown = narrowed ? all.filter((l) => !l.branch || l.branch._id === selected._id) : all

  return (
    <>
      <PageHeader
        title={narrowed ? `Payout lists, ${selected.name}` : "Payout lists"}
        description="Save the people you pay often, like monthly salaries or regular suppliers, and pay everyone on a list at once. Each payment is a bulk transfer, with your approval rules."
        actions={
          <>
            <Button variant="outline" asChild>
              <Link href="/beneficiaries">
                <BookUser data-icon="inline-start" aria-hidden />
                Beneficiaries
              </Link>
            </Button>
            {canManage && all.length > 0 && (
              <Button asChild>
                <Link href="/payout-lists/new">
                  <Plus data-icon="inline-start" aria-hidden />
                  New payout list
                </Link>
              </Button>
            )}
          </>
        }
      />
      {lists.ok ? (
        <PayoutListsView
          lists={shown}
          total={all.length}
          canManage={canManage}
          showBranch={!narrowed && branches.length > 1}
          branchName={narrowed ? selected.name : undefined}
        />
      ) : (
        <PayoutsUnavailable what="payout lists" />
      )}
    </>
  )
}
