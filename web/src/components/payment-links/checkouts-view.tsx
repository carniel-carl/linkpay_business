"use client"

import { useMemo } from "react"
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
import type { LinkCheckout, LinkCheckoutList } from "@/lib/api/types"
import { formatNaira, formatShortDate, formatTime } from "@/lib/format"
import { CHECKOUT_TAB_LABELS, CHECKOUT_TABS, DEFAULT_PAGE_SIZE, PAGE_SIZES, type CheckoutTab } from "@/lib/payment-links"
import { CheckoutSheet } from "./checkout-sheet"
import { useUrlState, UnderlineTabs } from "./links-view"
import { CheckoutStatusBadge, SourceTag, TestBadge } from "./parts"

type Patch = Record<string, string | undefined>
const helper = createColumnHelper<DataTableFeatures, LinkCheckout>()
const resolve = <T,>(updater: Updater<T>, old: T) => (typeof updater === "function" ? (updater as (old: T) => T)(old) : updater)

type ViewQuery = { tab: CheckoutTab; q?: string; page: number; size: number; checkout?: string }

/** What each status tab shows, in the empty state. */
const EMPTY_COPY: Record<CheckoutTab, string> = {
  received: "Nobody has paid yet. Payments show here as soon as the transfer lands.",
  pending: "Nobody is in the middle of paying right now.",
  expired: "No payments ran out of time.",
  all: "Nobody has started paying yet.",
}

/**
 * Payers' checkouts with status tabs and search; a row opens its sheet (?checkout=<id>). Used for one link
 * (its detail page, tab in `?status=`) and across links (the Payments view, tab in `?checkouts=`).
 */
export function CheckoutsView({
  data,
  query,
  tabParam,
  showLink,
  showBranch,
  linked,
}: {
  data: LinkCheckoutList
  query: ViewQuery
  tabParam: "status" | "checkouts"
  showLink: boolean
  showBranch: boolean
  /** A checkout opened by link (?checkout=) that isn't on this page. */
  linked: LinkCheckout | null
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const parse = (p: Record<string, string>): ViewQuery => ({ ...query, tab: (p[tabParam] as CheckoutTab) ?? "received", q: p.q })
  const { shown, pending, navigate } = useUrlState(query, parse)

  const qs = searchParams.toString()
  const hrefFor = (id: string) => {
    const params = new URLSearchParams(qs)
    params.set("checkout", id)
    return `${pathname}?${params}`
  }
  const closeSheet = () => {
    const params = new URLSearchParams(searchParams.toString())
    params.delete("checkout")
    const qs = params.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }
  const open = query.checkout ? (data.items.find((c) => c._id === query.checkout) ?? (linked?._id === query.checkout ? linked : null)) : null

  const columns = useMemo(
    () =>
      helper.columns([
        helper.accessor((c) => c.payer.name, {
          id: "payer",
          header: "Customer",
          cell: ({ row }) => (
            <div className="grid min-w-44 gap-0.5">
              <Link
                href={hrefFor(row.original._id)}
                scroll={false}
                className="w-fit font-medium outline-none after:absolute after:inset-0 hover:underline focus-visible:underline"
              >
                {row.original.payer.name}
              </Link>
              <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                <span className="figure">{row.original.reference}</span>
                {row.original.clientReference && <span className="figure">{row.original.clientReference}</span>}
                <SourceTag checkout={row.original} />
              </span>
            </div>
          ),
          meta: { label: "Customer" },
        }),
        helper.accessor((c) => c.link?.title, {
          id: "link",
          header: "Link",
          cell: ({ getValue }) => <span className="line-clamp-2 min-w-32">{getValue() ?? "Deleted link"}</span>,
          meta: { label: "Link" },
        }),
        helper.accessor((c) => c.branch?.name, {
          id: "branch",
          header: "Paid into",
          cell: ({ getValue }) => <span className="whitespace-nowrap">{getValue() ?? "Unknown"}</span>,
          meta: { label: "Paid into", className: "hidden xl:table-cell" },
        }),
        helper.accessor("createdAt", {
          header: "Started",
          cell: ({ row }) => (
            <span className="grid gap-0.5 whitespace-nowrap">
              <span className="figure">{formatShortDate(row.original.createdAt)}</span>
              <span className="text-xs text-muted-foreground figure">{formatTime(row.original.createdAt)}</span>
            </span>
          ),
          meta: { label: "Started", className: "hidden lg:table-cell" },
        }),
        helper.accessor("status", {
          header: "Status",
          cell: ({ row }) => (
            <span className="flex items-center gap-1.5">
              <CheckoutStatusBadge status={row.original.status} />
              <TestBadge mode={row.original.mode} />
            </span>
          ),
          meta: { label: "Status" },
        }),
        helper.accessor("priceKobo", {
          header: "Amount",
          cell: ({ row }) => (
            <div className="grid justify-items-end gap-0.5 whitespace-nowrap">
              <span className="font-medium figure">{formatNaira(row.original.paidKobo ?? row.original.priceKobo)}</span>
              {row.original.status === "underpaid" && (
                <span className="text-xs text-muted-foreground figure">of {formatNaira(row.original.priceKobo)}</span>
              )}
            </div>
          ),
          meta: { label: "Amount", className: "text-right" },
        }),
      ]),
    // hrefFor reads the current URL; the columns only need rebuilding when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [qs, pathname],
  )

  const pagination: PaginationState = useMemo(() => ({ pageIndex: query.page - 1, pageSize: query.size }), [query.page, query.size])
  const table = useTable({
    features: dataTableFeatures,
    columns,
    data: data.items,
    getRowId: (row) => row._id,
    manualPagination: true,
    rowCount: data.total,
    state: { pagination, columnVisibility: { link: showLink, branch: showBranch } },
    onPaginationChange: (updater) => {
      const next = resolve(updater, pagination)
      const sizeChanged = next.pageSize !== pagination.pageSize
      navigate({
        size: next.pageSize === DEFAULT_PAGE_SIZE ? undefined : String(next.pageSize),
        page: sizeChanged || next.pageIndex === 0 ? undefined : String(next.pageIndex + 1),
      } satisfies Patch)
    },
  })

  const emptyState = (
    <Empty className="min-h-72 border-0">
      <EmptyHeader>
        <EmptyMedia variant="icon">{query.q ? <SearchX aria-hidden /> : <ReceiptText aria-hidden />}</EmptyMedia>
        <EmptyTitle>{query.q ? "No matches" : "Nothing here yet"}</EmptyTitle>
        <EmptyDescription>{query.q ? <>Nothing matches &ldquo;{query.q}&rdquo; here.</> : EMPTY_COPY[query.tab]}</EmptyDescription>
      </EmptyHeader>
      {(query.q || query.tab !== "all") && data.total === 0 && (
        <EmptyContent>
          <Button variant="outline" onClick={() => navigate({ [tabParam]: "all", q: undefined, page: undefined })}>
            Show every payment
          </Button>
        </EmptyContent>
      )}
    </Empty>
  )

  return (
    <div className="surface overflow-hidden" aria-busy={pending}>
      <p role="status" aria-live="polite" className="sr-only">
        {pending ? "Loading payments" : ""}
      </p>
      <UnderlineTabs
        label="Payment status"
        tabs={CHECKOUT_TABS.map((t) => [t, CHECKOUT_TAB_LABELS[t]] as const)}
        current={shown.tab}
        onSelect={(t) => navigate({ [tabParam]: t === "received" ? undefined : t, page: undefined, checkout: undefined })}
      />
      <div className="px-4 py-3 sm:px-6">
        <SearchBox
          id="checkout-search"
          label="Search payments"
          placeholder="Name, email, LP reference or your order number"
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
            <DataTable table={table} caption="Payments through links" rowClassName="relative cursor-pointer has-[a:focus-visible]:bg-muted/60" empty={emptyState} />
          </div>
          <div className="border-t md:hidden">
            {data.items.length === 0 ? (
              emptyState
            ) : (
              <ul className="divide-y">
                {data.items.map((c) => (
                  <li key={c._id}>
                    <Link
                      href={hrefFor(c._id)}
                      scroll={false}
                      className="flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-muted/50 focus-visible:bg-muted/60 focus-visible:outline-none"
                    >
                      <span className="grid min-w-0 flex-1 gap-0.5">
                        <span className="truncate font-medium">{c.payer.name}</span>
                        <span className="truncate text-xs text-muted-foreground">
                          {showLink && c.link ? `${c.link.title} · ` : ""}
                          {formatShortDate(c.createdAt)}
                        </span>
                      </span>
                      <span className="grid justify-items-end gap-1">
                        <span className="font-medium figure">{formatNaira(c.paidKobo ?? c.priceKobo)}</span>
                        <span className="flex items-center gap-1">
                          <TestBadge mode={c.mode} />
                          <CheckoutStatusBadge status={c.status} />
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}

      {data.total > 0 && <DataTablePagination table={table} pageSizes={PAGE_SIZES} noun="payments" />}

      <CheckoutSheet checkout={open} onClose={closeSheet} />
    </div>
  )
}
