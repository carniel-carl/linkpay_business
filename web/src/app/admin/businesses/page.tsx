import type { Metadata } from "next"
import { BusinessesTable } from "@/components/admin/businesses-table"
import { PageHeader } from "@/components/common/page-header"
import { parseAdminQuery, STATUS_FILTER_LABELS } from "@/lib/admin"
import { getAdminBusinesses, getAdminSummary } from "@/lib/data"
import type { BusinessStatus } from "@/lib/kyb"

export const metadata: Metadata = { title: "Businesses" }

const EMPTY: Record<BusinessStatus | "all", string> = {
  all: "No businesses have signed up yet.",
  submitted: "Nothing waiting for review.",
  changes_requested: "No businesses are waiting on their owners to make changes.",
  approved: "No approved businesses yet.",
  rejected: "No rejected businesses.",
  draft: "No businesses are still being set up.",
}

export default async function BusinessesPage({ searchParams }: PageProps<"/admin/businesses">) {
  // Newest sign-ups first: drafts have no submission date, so sorting by it would bury the rest.
  const query = parseAdminQuery(await searchParams, { sort: "created", dir: "desc" })
  const [data, summary] = await Promise.all([getAdminBusinesses(query), getAdminSummary()])
  const status = query.status ?? "all"

  return (
    <>
      <PageHeader title="Businesses" description="Every business on LinkPay, from first sign-up to approval." />
      <BusinessesTable
        data={data}
        query={query}
        counts={{ ...summary.counts, all: summary.total }}
        hiddenColumns={["registrationNumber", "people"]}
        caption={status === "all" ? "All businesses" : `${STATUS_FILTER_LABELS[status]} businesses`}
        emptyTitle="Nothing here"
        emptyDescription={EMPTY[status]}
      />
    </>
  )
}
