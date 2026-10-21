import type { Metadata } from "next"
import Link from "next/link"
import { Link2, Plus } from "lucide-react"
import { PageHeader } from "@/components/common/page-header"
import { FeaturePlaceholder } from "@/components/dashboard/feature-placeholder"
import { CheckoutsView } from "@/components/payment-links/checkouts-view"
import { LinksView } from "@/components/payment-links/links-view"
import { PaymentLinksLocked } from "@/components/payment-links/parts"
import { TransactionsUnavailable } from "@/components/transactions/transactions-unavailable"
import { Button } from "@/components/ui/button"
import type { PaymentLinkSummary } from "@/lib/api/types"
import { getLinkCheckout, getLinkCheckouts, getOverview, getPaymentLinks, getPaymentLinkSummary, getSelected } from "@/lib/data"
import { formatNaira } from "@/lib/format"
import { checkoutsApiParams, linksApiParams, parseLinksQuery, type LinksQuery } from "@/lib/payment-links"
import { can } from "@/lib/permissions"
import { cn } from "@/lib/utils"

export const metadata: Metadata = { title: "Payment links" }

export default async function PaymentLinksPage({ searchParams }: PageProps<"/payment-links">) {
  const overview = await getOverview()
  if (!overview || overview.business.status !== "approved") {
    return (
      <FeaturePlaceholder
        title="Payment links"
        icon={Link2}
        summary="Take payments with a link or a button on your website."
        detail="Share a link or add a pay button to your site. Customers pay by bank transfer and each payment is matched for you."
      />
    )
  }
  if (!can(overview, "accounts.view")) return <PaymentLinksLocked />

  const query = parseLinksQuery(await searchParams)
  const selected = await getSelected()
  const branches = overview.branches ?? []
  const payments = query.view === "payments"
  const canManage = can(overview, "payments.manage")
  // Links pay into a branch's account, so only branches whose account is open.
  const hasReadyBranch = branches.some((b) => b.account)

  const [summary, links, checkouts, linked] = await Promise.all([
    getPaymentLinkSummary(selected?._id),
    payments ? null : getPaymentLinks(linksApiParams(query, selected?._id)),
    payments ? getLinkCheckouts(checkoutsApiParams({ ...query, status: query.checkouts }, { branch: selected?._id })) : null,
    payments && query.checkout ? getLinkCheckout(query.checkout) : null,
  ])

  const newLink = canManage && hasReadyBranch && (
    <Button asChild>
      <Link href="/payment-links/new">
        <Plus data-icon="inline-start" aria-hidden />
        New payment link
      </Link>
    </Button>
  )
  const showBranch = !selected && branches.length > 1

  return (
    <>
      <PageHeader
        title={selected && branches.length > 1 ? `Payment links, ${selected.name}` : "Payment links"}
        description={
          <div className="grid gap-5">
            <span>
              {selected && branches.length > 1 ? `Showing links that pay into ${selected.name}. ` : ""}
              Share a link or put a pay button on your website. Customers pay by bank transfer, and each payment is matched to them by itself.
            </span>
            <ViewTabs current={query.view} />
          </div>
        }
        actions={newLink}
      />
      <div className="grid gap-6">
        <SummaryCard summary={summary.ok ? summary.data : null} />
        {payments ? (
          checkouts?.ok ? (
            <CheckoutsView
              data={checkouts.data}
              query={{ tab: query.checkouts, q: query.q, page: query.page, size: query.size, checkout: query.checkout }}
              tabParam="checkouts"
              showLink
              showBranch={showBranch}
              linked={linked?.ok ? linked.data : null}
            />
          ) : (
            <TransactionsUnavailable />
          )
        ) : links?.ok ? (
          <LinksView data={links.data} query={query} showBranch={showBranch} newLink={newLink} />
        ) : (
          <TransactionsUnavailable />
        )}
      </div>
    </>
  )
}

/** Money collected through links, all time and in the last 30 days. */
function SummaryCard({ summary }: { summary: PaymentLinkSummary | null }) {
  return (
    <section aria-label="Payment link totals" className="surface grid gap-6 p-6 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end sm:p-8">
      <div className="grid gap-1.5">
        <p className="text-sm text-muted-foreground">Collected through links</p>
        {summary ? (
          <>
            <p className="type-display text-[2.5rem] break-all sm:text-5xl figure">{formatNaira(summary.collectedKobo)}</p>
            <p className="text-sm text-muted-foreground">{summary.paymentsCount === 1 ? "1 payment" : `${summary.paymentsCount} payments`} in all</p>
          </>
        ) : (
          <p className="type-display text-3xl text-muted-foreground">Unavailable</p>
        )}
      </div>
      {summary && (
        <dl className="flex flex-wrap gap-x-8 gap-y-3 text-sm sm:justify-end">
          <div className="grid gap-0.5">
            <dt className="text-xs text-muted-foreground">Last 30 days</dt>
            <dd className="font-medium figure">
              {formatNaira(summary.last30Days.collectedKobo)}
              <span className="ml-1.5 text-xs font-normal text-muted-foreground">({summary.last30Days.paymentsCount})</span>
            </dd>
          </div>
          <div className="grid gap-0.5">
            <dt className="text-xs text-muted-foreground">Links on</dt>
            <dd className="font-medium figure">{summary.links.active}</dd>
          </div>
          {summary.links.inactive > 0 && (
            <div className="grid gap-0.5">
              <dt className="text-xs text-muted-foreground">Off</dt>
              <dd className="font-medium figure">{summary.links.inactive}</dd>
            </div>
          )}
        </dl>
      )}
    </section>
  )
}

/** Links or Payments, as pill tabs on the band (real links, so the back button works). */
function ViewTabs({ current }: { current: LinksQuery["view"] }) {
  const tabs = [
    { key: "links", label: "Links", href: "/payment-links" },
    { key: "payments", label: "Payments", href: "/payment-links?view=payments" },
  ] as const
  return (
    <nav aria-label="Payment links">
      <ul className="flex w-fit gap-1 rounded-full bg-brand-surface-foreground/[0.07] p-1">
        {tabs.map((t) => {
          const active = t.key === current
          return (
            <li key={t.key}>
              <Link
                href={t.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-flex h-8 items-center rounded-full px-4 text-sm transition-colors duration-150 outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                  active ? "bg-card font-medium text-foreground shadow-sm" : "text-brand-surface-muted hover:text-brand-surface-foreground",
                )}
              >
                {t.label}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
