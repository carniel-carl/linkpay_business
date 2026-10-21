import type { Metadata } from "next"
import Link from "next/link"
import { ScrollText, X } from "lucide-react"
import { ListFilters } from "@/components/activity/list-filters"
import { AuditList } from "@/components/compliance/audit-list"
import { PageHeader } from "@/components/common/page-header"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { AUDIT_ACTION_LABELS, AUDIT_ACTIONS, parseAuditQuery } from "@/lib/compliance"
import { getAuditLog } from "@/lib/data"
import { requirePermission } from "@/lib/guard"

export const metadata: Metadata = { title: "Audit log" }

export default async function AuditLogPage({ searchParams }: PageProps<"/audit">) {
  const blocked = await requirePermission("compliance.view", "Audit log")
  if (blocked) return blocked
  const query = parseAuditQuery(await searchParams)
  const log = await getAuditLog(query)

  // Links keep the filters and move the cursor.
  const link = (patch: Record<string, string | undefined>) => {
    const params = new URLSearchParams()
    const merged = { action: query.action, staff: query.staff, business: query.business, before: query.before, ...patch }
    for (const [k, v] of Object.entries(merged)) if (v) params.set(k, v)
    const qs = params.toString()
    return qs ? `/audit?${qs}` : "/audit"
  }
  // Every entry on a staff-filtered page is by that person, so the name comes from the first one.
  const staffName = query.staff ? (log.items.find((e) => e.actor._id === query.staff)?.actor.name ?? "One staff member") : null
  const businessName = query.business ? (log.items.find((e) => e.business?._id === query.business)?.business?.name ?? "One business") : null

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Every staff action and every automatic flag, newest first. Entries can't be edited or removed."
      />
      <section aria-label="Audit log" className="surface overflow-hidden">
        <div className="flex flex-wrap items-end gap-3 pr-4 sm:pr-6">
          <ListFilters
            id="audit"
            reset={["before"]}
            selects={[
              {
                key: "action",
                label: "Action",
                any: "Every action",
                options: AUDIT_ACTIONS.map((a) => ({ value: a, label: AUDIT_ACTION_LABELS[a] })),
              },
            ]}
          />
          {staffName && (
            <Button variant="outline" size="sm" className="mb-3.5" asChild>
              <Link href={link({ staff: undefined, before: undefined })}>
                By {staffName}
                <X data-icon="inline-end" aria-hidden />
                <span className="sr-only">. Remove filter</span>
              </Link>
            </Button>
          )}
          {businessName && (
            <Button variant="outline" size="sm" className="mb-3.5" asChild>
              <Link href={link({ business: undefined, before: undefined })}>
                {businessName}
                <X data-icon="inline-end" aria-hidden />
                <span className="sr-only">. Remove filter</span>
              </Link>
            </Button>
          )}
        </div>
        <div className="border-t p-5 sm:p-6">
          {log.items.length === 0 ? (
            <Empty className="min-h-56 border-0">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <ScrollText aria-hidden />
                </EmptyMedia>
                <EmptyTitle>{query.action || query.staff || query.business || query.before ? "Nothing here" : "No entries yet"}</EmptyTitle>
                <EmptyDescription>
                  {query.before ? "There are no older entries." : "Staff actions and automatic flags are recorded here as they happen."}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <AuditList entries={log.items} showBusiness />
          )}
        </div>
        {(query.before || log.nextBefore) && (
          <nav aria-label="Pages" className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3 sm:px-6">
            {query.before ? (
              <Button variant="outline" size="sm" asChild>
                <Link href={link({ before: undefined })}>Back to newest</Link>
              </Button>
            ) : (
              <span />
            )}
            {log.nextBefore && (
              <Button variant="outline" size="sm" asChild>
                <Link href={link({ before: log.nextBefore })}>Older entries</Link>
              </Button>
            )}
          </nav>
        )}
      </section>
    </>
  )
}
