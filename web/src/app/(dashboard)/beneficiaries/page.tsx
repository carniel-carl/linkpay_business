import type { Metadata } from "next"
import Link from "next/link"
import { BookUser, FileUp, ListChecks, UserPlus } from "lucide-react"
import { PageHeader } from "@/components/common/page-header"
import { FeaturePlaceholder } from "@/components/dashboard/feature-placeholder"
import { BeneficiariesView } from "@/components/payouts/beneficiaries-view"
import { BeneficiaryFormDialog } from "@/components/payouts/beneficiary-form-dialog"
import { BeneficiaryImportDialog } from "@/components/payouts/beneficiary-import-dialog"
import { PayoutsLocked } from "@/components/payouts/parts"
import { PayoutsUnavailable } from "@/components/payouts/unavailable"
import { Button } from "@/components/ui/button"
import { getBeneficiaries, getOverview } from "@/lib/data"
import { beneficiaryApiParams, parseBeneficiaryQuery } from "@/lib/payouts"
import { can } from "@/lib/permissions"

export const metadata: Metadata = { title: "Beneficiaries" }

export default async function BeneficiariesPage({ searchParams }: PageProps<"/beneficiaries">) {
  const overview = await getOverview()
  if (!overview || overview.business.status !== "approved") {
    return (
      <FeaturePlaceholder
        title="Beneficiaries"
        icon={BookUser}
        summary="The people and businesses you pay, saved for your whole team."
        detail="Save the accounts you pay often, checked with their bank once, and pay them together from a payout list."
      />
    )
  }
  if (!can(overview, "accounts.view")) return <PayoutsLocked title="Beneficiaries" />

  const query = parseBeneficiaryQuery(await searchParams)
  // Saving, renaming and deleting need the right to prepare transfers.
  const canManage = can(overview, "transfers.create")
  const list = await getBeneficiaries(beneficiaryApiParams(query))

  const add = canManage && (
    <BeneficiaryFormDialog>
      <Button>
        <UserPlus data-icon="inline-start" aria-hidden />
        Add beneficiary
      </Button>
    </BeneficiaryFormDialog>
  )

  return (
    <>
      <PageHeader
        title="Beneficiaries"
        description="The people and businesses you pay, checked with their bank once and saved for your whole team. Put them on a payout list to pay them together."
        actions={
          <>
            {/* Icons only on phones, so all three fit beside each other. */}
            <Button variant="outline" className="max-sm:w-9 max-sm:px-0!" asChild>
              <Link href="/payout-lists">
                <ListChecks data-icon="inline-start" aria-hidden />
                <span className="max-sm:sr-only">Payout lists</span>
              </Link>
            </Button>
            {canManage && (
              <BeneficiaryImportDialog>
                <Button variant="outline" className="max-sm:w-9 max-sm:px-0!">
                  <FileUp data-icon="inline-start" aria-hidden />
                  <span className="max-sm:sr-only">Import</span>
                </Button>
              </BeneficiaryImportDialog>
            )}
            {add}
          </>
        }
      />
      {list.ok ? (
        <BeneficiariesView data={list.data} query={query} canManage={canManage} addButton={add || undefined} />
      ) : (
        <PayoutsUnavailable what="beneficiaries" />
      )}
    </>
  )
}
