import type { Metadata } from "next"
import { Landmark, Lock } from "lucide-react"
import { AccountsList } from "@/components/accounts/accounts-list"
import { PageHeader } from "@/components/common/page-header"
import { FeaturePlaceholder } from "@/components/dashboard/feature-placeholder"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { setupStatusFor } from "@/lib/branches"
import { getAccounts, getOverview, getSelected } from "@/lib/data"
import { can } from "@/lib/permissions"

export const metadata: Metadata = { title: "Accounts" }

const branchIdOf = (b: unknown) => (typeof b === "string" ? b : (b as { _id?: string } | undefined)?._id)

export default async function AccountsPage() {
  const overview = await getOverview()
  if (!overview || overview.business.status !== "approved") {
    return (
      <FeaturePlaceholder
        title="Accounts"
        icon={Landmark}
        summary="Your business accounts, balances and account numbers."
        detail="Your naira account opens as soon as your business is verified."
      />
    )
  }

  if (!can(overview, "accounts.view")) {
    return (
      <>
        <PageHeader title="Accounts" description="Your business accounts, balances and account numbers." />
        <Empty className="surface min-h-80 border-0 p-10">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Lock aria-hidden />
            </EmptyMedia>
            <EmptyTitle>Accounts aren&apos;t part of your role</EmptyTitle>
            <EmptyDescription>Ask the business owner or an admin if you need to see account numbers and balances.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    )
  }

  const [accounts, selected] = await Promise.all([getAccounts(), getSelected()])
  // Account details from the overview, narrowed like the live list, in case balances can't load.
  const fallback = (overview.accounts ?? []).filter((a) => !selected || branchIdOf(a.branch) === selected._id)

  return (
    <>
      <PageHeader
        title={selected ? `Accounts, ${selected.name}` : "Accounts"}
        description={
          selected
            ? "This branch's naira account. Switch to All branches in the sidebar to see every account."
            : "Naira accounts held with our partner bank, one per branch. Share an account number to receive payments."
        }
      />
      {/* Keyed by business and branch: the list keeps its data in client state, so a switch means a fresh mount. */}
      <AccountsList
        key={`${overview.business._id}:${selected?._id ?? "all"}`}
        initial={accounts}
        setupStatus={setupStatusFor(overview, selected)}
        fallback={fallback}
      />
    </>
  )
}
