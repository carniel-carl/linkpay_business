"use client"

import { useMemo, useOptimistic, useTransition } from "react"
import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { createColumnHelper, useTable, type PaginationState, type Updater } from "@tanstack/react-table"
import { ReceiptText, SearchX } from "lucide-react"
import { DataTable, dataTableFeatures, type DataTableFeatures } from "@/components/data-table/data-table"
import { DataTablePagination } from "@/components/data-table/data-table-pagination"
import { SearchBox } from "@/components/data-table/search-box"
import { RowsSkeleton } from "@/components/transactions/skeletons"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import type { InvoiceList, InvoiceListItem } from "@/lib/api/types"
import { formatNaira } from "@/lib/format"
import {
  DEFAULT_PAGE_SIZE,
  dueLabel,
  formatDay,
  PAGE_SIZES,
  parseInvoiceQuery,
  TAB_LABELS,
  TABS,
  type InvoiceQuery,
  type InvoiceTab,
} from "@/lib/invoices"
import { cn } from "@/lib/utils"
import { InvoiceStatusBadge } from "./parts"

type Patch = Record<string, string | undefined>

const helper = createColumnHelper<DataTableFeatures, InvoiceListItem>()

const resolve = <T,>(updater: Updater<T>, old: T) =>
  typeof updater === "function" ? (updater as (old: T) => T)(old) : updater

const unpaid = (i: InvoiceListItem) => i.status === "open" || i.status === "partially_paid"

type Props = {
  data: InvoiceList
  query: InvoiceQuery
  showBranch: boolean
  /** "New invoice", shown in the first-time empty state. */
  newInvoice?: React.ReactNode
}

export function InvoicesView({ data, query, showBranch, newInvoice }: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [pending, startTransition] = useTransition()
  const [shown, setShown] = useOptimistic(query)

  function navigate(patch: Patch) {
    const params = new URLSearchParams(searchParams.toString())
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || value === "") params.delete(key)
      else params.set(key, value)
    }
    const qs = params.toString()
    startTransition(() => {
      setShown(parseInvoiceQuery(Object.fromEntries(params)))
      router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
    })
  }

  const columns = useMemo(
    () =>
      helper.columns([
        helper.accessor("number", {
          header: "Invoice",
          cell: ({ row }) => (
            <div className="grid min-w-40 gap-0.5">
              <Link
                href={`/invoices/${row.original._id}`}
                className="w-fit font-medium outline-none after:absolute after:inset-0 hover:underline focus-visible:underline"
              >
                {row.original.customer.name}
              </Link>
              <span className="text-xs text-muted-foreground figure">{row.original.number}</span>
            </div>
          ),
          meta: { label: "Invoice" },
        }),
        helper.accessor("issueDate", {
          header: "Issued",
          cell: ({ getValue }) => <span className="whitespace-nowrap figure">{formatDay(getValue())}</span>,
          meta: { label: "Issued", className: "hidden lg:table-cell" },
        }),
        helper.accessor("dueDate", {
          header: "Due",
          cell: ({ row }) => (
            <div className="grid gap-0.5 whitespace-nowrap">
              <span className="figure">{formatDay(row.original.dueDate)}</span>
              {unpaid(row.original) && (
                <span className={cn("text-xs", row.original.overdue ? "text-destructive" : "text-muted-foreground")}>
                  {dueLabel(row.original.dueDate)}
                </span>
              )}
            </div>
          ),
          meta: { label: "Due" },
        }),
        helper.accessor((i) => i.branch?.name, {
          id: "branch",
          header: "Paid into",
          cell: ({ getValue }) => <span className="whitespace-nowrap">{getValue() ?? "Unknown"}</span>,
          meta: { label: "Paid into" },
        }),
        helper.accessor("status", {
          header: "Status",
          cell: ({ row }) => <InvoiceStatusBadge invoice={row.original} />,
          meta: { label: "Status" },
        }),
        helper.accessor("totalKobo", {
          header: "Amount",
          cell: ({ row }) => (
            <div className="grid justify-items-end gap-0.5 whitespace-nowrap">
              <span className="font-medium figure">{formatNaira(row.original.totalKobo)}</span>
              {row.original.status === "partially_paid" && (
                <span className="text-xs text-muted-foreground figure">{formatNaira(row.original.balanceKobo)} left</span>
              )}
            </div>
          ),
          meta: { label: "Amount", className: "text-right" },
        }),
      ]),
    [],
  )

  const pagination: PaginationState = useMemo(() => ({ pageIndex: query.page - 1, pageSize: query.size }), [query.page, query.size])

  const table = useTable({
    features: dataTableFeatures,
    columns,
    data: data.items,
    getRowId: (row) => row._id,
    manualPagination: true,
    rowCount: data.total,
    state: { pagination, columnVisibility: { branch: showBranch } },
    onPaginationChange: (updater) => {
      const next = resolve(updater, pagination)
      const sizeChanged = next.pageSize !== pagination.pageSize
      navigate({
        size: next.pageSize === DEFAULT_PAGE_SIZE ? undefined : String(next.pageSize),
        page: sizeChanged || next.pageIndex === 0 ? undefined : String(next.pageIndex + 1),
      })
    },
  })

  const firstEver = data.total === 0 && query.tab === "all" && !query.q

  const emptyState = firstEver ? (
    <Empty className="min-h-80 border-0">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <ReceiptText aria-hidden />
        </EmptyMedia>
        <EmptyTitle>No invoices yet</EmptyTitle>
        <EmptyDescription>
          Bill a customer in your own branding. They pay into your account, and we mark the invoice paid when the money lands.
        </EmptyDescription>
      </EmptyHeader>
      {newInvoice && <EmptyContent>{newInvoice}</EmptyContent>}
    </Empty>
  ) : (
    <Empty className="min-h-80 border-0">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <SearchX aria-hidden />
        </EmptyMedia>
        <EmptyTitle>{query.tab === "overdue" && !query.q ? "Nothing overdue" : "No matches"}</EmptyTitle>
        <EmptyDescription>
          {query.q ? <>Nothing matches &ldquo;{query.q}&rdquo; here.</> : `No invoices are ${TAB_LABELS[query.tab].toLowerCase()} right now.`}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button variant="outline" onClick={() => navigate({ tab: undefined, q: undefined, page: undefined })}>
          Show all invoices
        </Button>
      </EmptyContent>
    </Empty>
  )

  return (
    <div className="surface overflow-hidden" aria-busy={pending}>
      <p role="status" aria-live="polite" className="sr-only">
        {pending ? "Loading invoices" : ""}
      </p>
      <nav aria-label="Invoice status" className="overflow-x-auto px-4 pt-2 sm:px-6">
        <ul className="flex w-max min-w-full gap-1 border-b">
          {TABS.map((t) => {
            const active = shown.tab === t
            return (
              <li key={t}>
                <button
                  type="button"
                  aria-current={active ? "page" : undefined}
                  onClick={() => !active && navigate({ tab: t === "all" ? undefined : (t as InvoiceTab), page: undefined })}
                  className={cn(
                    "-mb-px inline-flex h-10 items-center rounded-t-md border-b-2 px-3 text-sm whitespace-nowrap transition-colors duration-150 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                    active ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  {TAB_LABELS[t]}
                </button>
              </li>
            )
          })}
        </ul>
      </nav>

      <div className="px-4 py-3 sm:px-6">
        <SearchBox
          id="invoice-search"
          label="Search invoices"
          placeholder="Customer, email or invoice number"
          value={query.q ?? ""}
          onSearch={(q) => navigate({ q, page: undefined })}
          className="w-full sm:w-96"
        />
      </div>

      {pending ? (
        <div className="border-t">
          <RowsSkeleton rows={Math.min(Math.max(data.items.length, 5), 10)} showBranch={showBranch} />
        </div>
      ) : (
        <>
          <div className="hidden border-t md:block">
            <DataTable table={table} caption="Invoices" rowClassName="relative cursor-pointer has-[a:focus-visible]:bg-muted/60" empty={emptyState} />
          </div>
          <div className="border-t md:hidden">
            {data.items.length === 0 ? (
              emptyState
            ) : (
              <ul className="divide-y">
                {data.items.map((i) => (
                  <li key={i._id}>
                    <Link
                      href={`/invoices/${i._id}`}
                      className="flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-muted/50 focus-visible:bg-muted/60 focus-visible:outline-none"
                    >
                      <span className="grid min-w-0 flex-1 gap-0.5">
                        <span className="truncate font-medium">{i.customer.name}</span>
                        <span className="truncate text-xs text-muted-foreground">
                          <span className="figure">{i.number}</span> · {unpaid(i) ? dueLabel(i.dueDate) : `Due ${formatDay(i.dueDate)}`}
                        </span>
                      </span>
                      <span className="grid justify-items-end gap-1">
                        <span className="font-medium figure">{formatNaira(i.totalKobo)}</span>
                        <InvoiceStatusBadge invoice={i} />
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}

      {data.total > 0 && <DataTablePagination table={table} pageSizes={PAGE_SIZES} noun="invoices" />}
    </div>
  )
}
