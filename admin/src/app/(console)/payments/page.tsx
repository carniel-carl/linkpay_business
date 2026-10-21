import type { Metadata } from "next"
import { ListFilters } from "@/components/activity/list-filters"
import { PaymentsTable } from "@/components/activity/money-tables"
import { PageHeader } from "@/components/common/page-header"
import { Pager } from "@/components/common/url-state"
import { DIRECTION_LABELS, PAGE_SIZE, parsePaymentQuery, TRANSACTION_STATUS_LABELS } from "@/lib/compliance"
import { getPaymentsFeed } from "@/lib/data"
import { requirePermission } from "@/lib/guard"

export const metadata: Metadata = { title: "Payments" }

const entries = (labels: Record<string, string>) => Object.entries(labels).map(([value, label]) => ({ value, label }))

export default async function PaymentsFeedPage({ searchParams }: PageProps<"/payments">) {
  const blocked = await requirePermission("activity.view", "Payments")
  if (blocked) return blocked
  const query = parsePaymentQuery(await searchParams)
  const feed = await getPaymentsFeed(query)
  const filtered = !!(query.direction || query.status || query.min || query.from || query.to || query.q)

  return (
    <>
      <PageHeader title="Payments" description="Money in and out of every business on LinkPay, newest first." />
      <section aria-label="Payments" className="surface overflow-hidden">
        <ListFilters
          id="feed"
          search={{ label: "Search payments", placeholder: "Name, account, narration or reference" }}
          selects={[
            { key: "direction", label: "Direction", any: "In and out", options: entries(DIRECTION_LABELS) },
            { key: "status", label: "Status", any: "Any status", options: entries(TRANSACTION_STATUS_LABELS) },
          ]}
          amount
          dates
        />
        <div className="border-t">
          <PaymentsTable items={feed.items} caption="Payments across every business" showBusiness filtered={filtered} />
        </div>
        <Pager total={feed.total} page={query.page} pageSize={PAGE_SIZE} noun="payments" />
      </section>
    </>
  )
}
