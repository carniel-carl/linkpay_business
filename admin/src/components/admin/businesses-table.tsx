"use client"

import { useMemo, useTransition } from "react"
import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import {
  createColumnHelper,
  useTable,
  type ColumnVisibilityState,
  type PaginationState,
  type SortingState,
  type Updater,
} from "@tanstack/react-table"
import { Inbox, SearchX, X } from "lucide-react"
import { StatusBadge } from "@/components/business/status-badge"
import { DataTable, dataTableFeatures, type DataTableFeatures } from "@/components/data-table/data-table"
import { DataTableColumnHeader } from "@/components/data-table/data-table-column-header"
import { DataTablePagination } from "@/components/data-table/data-table-pagination"
import { DataTableViewOptions } from "@/components/data-table/data-table-view-options"
import { SearchBox } from "@/components/data-table/search-box"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import {
  ADMIN_SORTS,
  COMPLIANCE_FILTER_LABELS,
  COMPLIANCE_FILTERS,
  PAGE_SIZES, STATUS_FILTER_LABELS, STATUS_FILTERS, type AdminListQuery, type AdminSort } from "@/lib/admin"
import type { AdminBusinessList, AdminSummary } from "@/lib/api/types"
import { formatDate, timeAgo } from "@/lib/format"
import { BUSINESS_TYPE_INFO, type BusinessStatus } from "@/lib/kyb"
import { cn } from "@/lib/utils"
import { RestrictionBadge, SeverityDot } from "@/components/compliance/badges"
import { SEVERITY_LABELS } from "@/lib/compliance"
import { AccountSetupBadge } from "./account-setup-badge"

type Row = AdminBusinessList["items"][number]

const helper = createColumnHelper<DataTableFeatures, Row>()

const columns = helper.columns([
  helper.accessor("name", {
    header: ({ column }) => <DataTableColumnHeader column={column} title="Business" />,
    cell: ({ row }) => (
      <div className="grid min-w-48 gap-0.5">
        <span className="flex flex-wrap items-center gap-2">
          <Link
            href={`/businesses/${row.original._id}`}
            className="w-fit font-medium outline-none after:absolute after:inset-0 hover:underline focus-visible:underline"
          >
            {row.original.name}
          </Link>
          <RestrictionBadge status={row.original.compliance?.status} />
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {[row.original.owner?.name, row.original.owner?.email].filter(Boolean).join(", ")}
        </span>
      </div>
    ),
    enableHiding: false,
    meta: { label: "Business" },
  }),
  helper.accessor("type", {
    header: "Type",
    cell: ({ getValue }) => <span className="text-muted-foreground">{BUSINESS_TYPE_INFO[getValue()]?.label}</span>,
    enableSorting: false,
    meta: { label: "Type" },
  }),
  helper.accessor("registrationNumber", {
    header: "RC / BN",
    cell: ({ getValue }) =>
      getValue() ? <span className="font-mono text-xs">{getValue()}</span> : <span className="text-muted-foreground">Not given</span>,
    enableSorting: false,
    meta: { label: "RC / BN number" },
  }),
  helper.accessor((b) => b.people.length, {
    id: "people",
    header: "People",
    cell: ({ getValue }) => <span className="figure">{getValue()}</span>,
    enableSorting: false,
    meta: { label: "People", className: "text-right" },
  }),
  helper.accessor("submittedAt", {
    id: "submitted",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Submitted" />,
    cell: ({ getValue }) => <DateCell iso={getValue()} fallback="Not yet" />,
    meta: { label: "Submitted" },
  }),
  helper.accessor("createdAt", {
    id: "created",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Signed up" />,
    cell: ({ getValue }) => <DateCell iso={getValue()} fallback="Unknown" />,
    meta: { label: "Signed up" },
  }),
  helper.accessor((b) => b.liquifia?.accountStatus, {
    id: "account",
    header: "Bank account",
    cell: ({ row, getValue }) =>
      row.original.status === "approved" ? (
        <AccountSetupBadge status={getValue() ?? "not_started"} />
      ) : (
        <span className="text-muted-foreground">After approval</span>
      ),
    enableSorting: false,
    meta: { label: "Bank account" },
  }),
  helper.accessor((b) => b.compliance?.openFlags ?? 0, {
    id: "flags",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Open flags" />,
    cell: ({ row, getValue }) => {
      const count = getValue()
      const severity = row.original.compliance?.highestOpenSeverity
      if (!count) return <span className="text-muted-foreground">None</span>
      return (
        <span className="inline-flex items-center gap-2 whitespace-nowrap">
          {severity && <SeverityDot severity={severity} />}
          <span className="figure">{count}</span>
          {severity && <span className="text-xs text-muted-foreground">{SEVERITY_LABELS[severity].toLowerCase()} at most</span>}
        </span>
      )
    },
    sortDescFirst: true,
    meta: { label: "Open flags" },
  }),
  helper.accessor("status", {
    header: "Status",
    cell: ({ getValue }) => <StatusBadge status={getValue()} />,
    enableSorting: false,
    meta: { label: "Status" },
  }),
])

function DateCell({ iso, fallback }: { iso?: string; fallback: string }) {
  if (!iso) return <span className="text-muted-foreground">{fallback}</span>
  return (
    <div className="grid gap-0.5 whitespace-nowrap">
      <span className="figure">{formatDate(iso)}</span>
      <span className="text-xs text-muted-foreground">{timeAgo(iso)}</span>
    </div>
  )
}

const resolve = <T,>(updater: Updater<T>, old: T) =>
  typeof updater === "function" ? (updater as (old: T) => T)(old) : updater

type Props = {
  data: AdminBusinessList
  query: AdminListQuery
  /** Shows status tabs with these counts. Leave out for a fixed-status list such as the review queue. */
  counts?: AdminSummary["counts"] & { all: number }
  /** Columns hidden until the viewer turns them on from the Columns menu. */
  hiddenColumns?: string[]
  /** Status used when the URL has none, so the default view keeps a clean URL. */
  defaultStatus?: BusinessStatus
  caption: string
  emptyTitle: string
  emptyDescription: string
  /**
   * Compliance chips with counts. Flags (the chip and the column) need compliance.view; any role can
   * filter to suspended and closed businesses.
   */
  compliance?: { counts: AdminSummary["compliance"]; showFlags: boolean }
}

export function BusinessesTable({
  data,
  query,
  counts,
  hiddenColumns = [],
  defaultStatus,
  caption,
  emptyTitle,
  emptyDescription,
  compliance,
}: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [pending, startTransition] = useTransition()

  /** Merges `patch` into the URL (undefined removes a key) and loads the new view. */
  function navigate(patch: Record<string, string | undefined>) {
    const params = new URLSearchParams(searchParams.toString())
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || value === "") params.delete(key)
      else params.set(key, value)
    }
    const qs = params.toString()
    startTransition(() => router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false }))
  }

  const sorting: SortingState = useMemo(() => [{ id: query.sort, desc: query.dir === "desc" }], [query.sort, query.dir])
  const pagination: PaginationState = useMemo(
    () => ({ pageIndex: query.page - 1, pageSize: query.size }),
    [query.page, query.size],
  )
  const initialVisibility = useMemo<ColumnVisibilityState>(
    () => Object.fromEntries(hiddenColumns.map((id) => [id, false])),
    [hiddenColumns],
  )

  const showFlags = !!compliance?.showFlags
  const visibleColumns = useMemo(() => (showFlags ? columns : columns.filter((c) => c.id !== "flags")), [showFlags])

  const table = useTable({
    features: dataTableFeatures,
    columns: visibleColumns,
    data: data.items,
    getRowId: (row) => row._id,
    manualSorting: true,
    manualPagination: true,
    rowCount: data.total,
    enableSortingRemoval: false,
    enableMultiSort: false,
    initialState: { columnVisibility: initialVisibility },
    state: { sorting, pagination },
    onSortingChange: (updater) => {
      const [next] = resolve(updater, sorting)
      if (!next || !(ADMIN_SORTS as readonly string[]).includes(next.id)) return
      navigate({ sort: next.id as AdminSort, dir: next.desc ? "desc" : "asc", page: undefined })
    },
    onPaginationChange: (updater) => {
      const next = resolve(updater, pagination)
      const sizeChanged = next.pageSize !== pagination.pageSize
      navigate({
        size: next.pageSize === 20 ? undefined : String(next.pageSize),
        page: sizeChanged || next.pageIndex === 0 ? undefined : String(next.pageIndex + 1),
      })
    },
  })

  const currentStatus = query.status ?? "all"
  const filtered = !!query.q || !!query.account || !!query.compliance
  const complianceChips = compliance ? COMPLIANCE_FILTERS.filter((c) => c !== "flagged" || showFlags) : []

  return (
    <div className="surface overflow-hidden">
      {counts && (
        <nav aria-label="Filter by status" className="overflow-x-auto border-b px-4 sm:px-6">
          <ul className="flex w-max min-w-full gap-1">
            {STATUS_FILTERS.map((s) => {
              const active = s === currentStatus
              const params = new URLSearchParams(searchParams.toString())
              params.delete("page")
              if (s === (defaultStatus ?? "all")) params.delete("status")
              else params.set("status", s)
              const qs = params.toString()
              return (
                <li key={s}>
                  <Link
                    href={qs ? `${pathname}?${qs}` : pathname}
                    scroll={false}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "-mb-px inline-flex h-12 items-center gap-2 border-b-2 px-3 text-sm whitespace-nowrap transition-colors duration-150",
                      "rounded-t-md focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                      active
                        ? "border-primary font-medium text-foreground"
                        : "border-transparent text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {STATUS_FILTER_LABELS[s]}
                    <span
                      className={cn(
                        "figure rounded-md px-1.5 py-px text-xs",
                        active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
                      )}
                    >
                      {counts[s]}
                    </span>
                  </Link>
                </li>
              )
            })}
          </ul>
        </nav>
      )}

      <div className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-6">
        <SearchBox
          id="business-search"
          label="Search businesses"
          placeholder="Name, RC number or owner email"
          value={query.q ?? ""}
          onSearch={(q) => navigate({ q, page: undefined })}
        />
        {complianceChips.length > 0 && (
          <div role="group" aria-label="Compliance" className="flex flex-wrap gap-2">
            {complianceChips.map((c) => {
              const active = query.compliance === c
              return (
                <Button
                  key={c}
                  variant={active ? "default" : "outline"}
                  size="sm"
                  aria-pressed={active}
                  onClick={() =>
                    navigate({
                      compliance: active ? undefined : c,
                      page: undefined,
                      // Most flags first is what the Flagged view is for.
                      ...(c === "flagged" && !active ? { sort: "flags", dir: "desc" } : {}),
                    })
                  }
                >
                  {COMPLIANCE_FILTER_LABELS[c]}
                  <span className={cn("figure text-xs", active ? "opacity-80" : "text-muted-foreground")}>
                    {compliance!.counts[c]}
                  </span>
                </Button>
              )
            })}
          </div>
        )}
        {query.account === "failed" && (
          <Button variant="outline" size="sm" onClick={() => navigate({ account: undefined, page: undefined })}>
            Account setup failed
            <X data-icon="inline-end" aria-hidden />
            <span className="sr-only">. Remove filter</span>
          </Button>
        )}
        <div className="ml-auto">
          <DataTableViewOptions table={table} />
        </div>
      </div>

      <div className="border-t">
        <DataTable
          table={table}
          caption={caption}
          busy={pending}
          rowClassName="relative has-[a:focus-visible]:bg-muted/60"
          empty={
            filtered ? (
              <Empty className="min-h-72 border-0">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <SearchX aria-hidden />
                  </EmptyMedia>
                  <EmptyTitle>No matches</EmptyTitle>
                  <EmptyDescription>
                    Nothing matches {query.q ? <>&ldquo;{query.q}&rdquo;</> : "these filters"}. Try a business name, RC
                    number or the owner&apos;s email.
                  </EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <Button variant="outline" onClick={() => navigate({ q: undefined, account: undefined, compliance: undefined, page: undefined })}>
                    Clear search and filters
                  </Button>
                </EmptyContent>
              </Empty>
            ) : (
              <Empty className="min-h-72 border-0">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Inbox aria-hidden />
                  </EmptyMedia>
                  <EmptyTitle>{emptyTitle}</EmptyTitle>
                  <EmptyDescription>{emptyDescription}</EmptyDescription>
                </EmptyHeader>
              </Empty>
            )
          }
        />
      </div>

      {data.total > 0 && <DataTablePagination table={table} pageSizes={PAGE_SIZES} noun="businesses" />}
    </div>
  )
}
