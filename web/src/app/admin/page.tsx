import Link from "next/link"
import { ArrowUpRight } from "lucide-react"
import { BusinessesTable } from "@/components/admin/businesses-table"
import { PageHeader } from "@/components/common/page-header"
import { parseAdminQuery } from "@/lib/admin"
import { getAdminBusinesses, getAdminSummary } from "@/lib/data"
import { cn } from "@/lib/utils"

export default async function ReviewQueuePage({ searchParams }: PageProps<"/admin">) {
  const params = await searchParams
  // The queue only ever shows submitted businesses, oldest first unless re-sorted.
  const query = { ...parseAdminQuery(params), status: "submitted" as const }
  const [data, summary] = await Promise.all([getAdminBusinesses(query), getAdminSummary()])

  const stats = [
    { label: "Waiting for review", value: summary.counts.submitted, href: "/admin" },
    { label: "With owners for changes", value: summary.counts.changes_requested, href: "/admin/businesses?status=changes_requested" },
    { label: "Approved", value: summary.counts.approved, href: "/admin/businesses?status=approved" },
    {
      label: "Account setup failed",
      value: summary.accountSetupFailed,
      href: "/admin/businesses?status=approved&account=failed",
      alert: summary.accountSetupFailed > 0,
    },
  ]

  return (
    <>
      <PageHeader
        title="Review queue"
        description="Check each business's documents against CAC, FIRS and BVN records before approving."
      />

      <div className="grid gap-6">
        <ul aria-label="Summary" className="grid grid-cols-2 overflow-hidden surface lg:grid-cols-4">
          {stats.map((s, i) => (
            <li
              key={s.label}
              className={cn("border-border", i % 2 === 1 && "border-l", i > 1 && "border-t lg:border-t-0", i === 2 && "lg:border-l")}
            >
              <Link
                href={s.href}
                className="group grid h-full gap-2 p-4 transition-colors duration-150 outline-none hover:bg-muted/50 focus-visible:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset sm:p-6"
              >
                <span className="flex items-start justify-between gap-2 text-sm text-muted-foreground">
                  {s.label}
                  <ArrowUpRight
                    className="size-4 shrink-0 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100"
                    aria-hidden
                  />
                </span>
                <span className={cn("type-display figure text-3xl sm:text-4xl", s.alert && "text-destructive")}>{s.value}</span>
              </Link>
            </li>
          ))}
        </ul>

        <BusinessesTable
          data={data}
          query={query}
          hiddenColumns={["created", "account"]}
          caption="Businesses waiting for review"
          emptyTitle="You're all caught up"
          emptyDescription="Nothing is waiting for review. New submissions appear here, oldest first."
        />
      </div>
    </>
  )
}
