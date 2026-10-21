"use client"

import { useMemo, useOptimistic, useTransition } from "react"
import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { createColumnHelper, useTable, type PaginationState, type Updater } from "@tanstack/react-table"
import { Link2, SearchX } from "lucide-react"
import { DataTable, dataTableFeatures, type DataTableFeatures } from "@/components/data-table/data-table"
import { DataTablePagination } from "@/components/data-table/data-table-pagination"
import { SearchBox } from "@/components/data-table/search-box"
import { RowsSkeleton } from "@/components/transactions/skeletons"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import type { PaymentLink, PaymentLinkList } from "@/lib/api/types"
import { formatNaira, formatShortDate } from "@/lib/format"
import { DEFAULT_PAGE_SIZE, LINK_TAB_LABELS, LINK_TABS, linkImageSrc, PAGE_SIZES, parseLinksQuery, paymentsLabel, priceLabel, type LinksQuery } from "@/lib/payment-links"
import { cn } from "@/lib/utils"
import { LinkStateBadge } from "./parts"

type Patch = Record<string, string | undefined>
const helper = createColumnHelper<DataTableFeatures, PaymentLink>()
const resolve = <T,>(updater: Updater<T>, old: T) => (typeof updater === "function" ? (updater as (old: T) => T)(old) : updater)

export function useUrlState<Q>(query: Q, parse: (params: Record<string, string>) => Q) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [pending, startTransition] = useTransition()
  const [shown, setShown] = useOptimistic(query)

  function navigate(patch: Patch, { replace = false } = {}) {
    const params = new URLSearchParams(searchParams.toString())
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || value === "") params.delete(key)
      else params.set(key, value)
    }
    const qs = params.toString()
    const href = qs ? `${pathname}?${qs}` : pathname
    startTransition(() => {
      setShown(parse(Object.fromEntries(params)))
      if (replace) router.replace(href, { scroll: false })
      else router.push(href, { scroll: false })
    })
  }
  return { shown, pending, navigate }
}

/** The business's payment links: On / Off tabs, search by title, newest first. */
export function LinksView({ data, query, showBranch, newLink }: { data: PaymentLinkList; query: LinksQuery; showBranch: boolean; newLink?: React.ReactNode }) {
  const { shown, pending, navigate } = useUrlState(query, parseLinksQuery)

  const columns = useMemo(
    () =>
      helper.columns([
        helper.accessor("title", {
          header: "Link",
          cell: ({ row }) => (
            <div className="flex min-w-48 items-center gap-3">
              <LinkThumb link={row.original} />
              <div className="grid min-w-0 gap-0.5">
                <Link
                  href={`/payment-links/${row.original._id}`}
                  className="w-fit font-medium outline-none after:absolute after:inset-0 hover:underline focus-visible:underline"
                >
                  {row.original.title}
                </Link>
                <span className="truncate font-mono text-xs text-muted-foreground">/pay/{row.original.slug}</span>
              </div>
            </div>
          ),
          meta: { label: "Link" },
        }),
        helper.accessor((l) => priceLabel(l), {
          id: "price",
          header: "Price",
          cell: ({ getValue }) => <span className="whitespace-nowrap figure">{getValue()}</span>,
          meta: { label: "Price" },
        }),
        helper.accessor((l) => l.branch?.name, {
          id: "branch",
          header: "Paid into",
          cell: ({ getValue }) => <span className="whitespace-nowrap">{getValue() ?? "Unknown"}</span>,
          meta: { label: "Paid into", className: "hidden lg:table-cell" },
        }),
        helper.accessor("status", {
          header: "Status",
          cell: ({ row }) => <LinkStateBadge link={row.original} />,
          meta: { label: "Status" },
        }),
        helper.accessor("collectedKobo", {
          header: "Collected",
          cell: ({ row }) => (
            <div className="grid justify-items-end gap-0.5 whitespace-nowrap">
              <span className="font-medium figure">{formatNaira(row.original.collectedKobo)}</span>
              <span className="text-xs text-muted-foreground">
                {paymentsLabel(row.original)}
                {row.original.lastPaidAt ? `, last ${formatShortDate(row.original.lastPaidAt)}` : ""}
              </span>
            </div>
          ),
          meta: { label: "Collected", className: "text-right" },
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

  const firstEver = data.total === 0 && query.status === "all" && !query.q
  const emptyState = firstEver ? (
    <Empty className="min-h-80 border-0">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Link2 aria-hidden />
        </EmptyMedia>
        <EmptyTitle>No payment links yet</EmptyTitle>
        <EmptyDescription>
          Make a link for a product, a deposit or a donation. Share it anywhere or put a pay button on your website. Customers pay by bank transfer and
          we match each payment for you.
        </EmptyDescription>
      </EmptyHeader>
      {newLink && <EmptyContent>{newLink}</EmptyContent>}
    </Empty>
  ) : (
    <Empty className="min-h-80 border-0">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <SearchX aria-hidden />
        </EmptyMedia>
        <EmptyTitle>No matches</EmptyTitle>
        <EmptyDescription>{query.q ? <>No links match &ldquo;{query.q}&rdquo; here.</> : "No links here right now."}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button variant="outline" onClick={() => navigate({ status: undefined, q: undefined, page: undefined })}>
          Show all links
        </Button>
      </EmptyContent>
    </Empty>
  )

  return (
    <div className="surface overflow-hidden" aria-busy={pending}>
      <p role="status" aria-live="polite" className="sr-only">
        {pending ? "Loading payment links" : ""}
      </p>
      <UnderlineTabs
        label="Link status"
        tabs={LINK_TABS.map((t) => [t, LINK_TAB_LABELS[t]] as const)}
        current={shown.status}
        onSelect={(t) => navigate({ status: t === "all" ? undefined : t, page: undefined })}
      />
      <div className="px-4 py-3 sm:px-6">
        <SearchBox
          id="link-search"
          label="Search payment links"
          placeholder="Search by title"
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
            <DataTable table={table} caption="Payment links" rowClassName="relative cursor-pointer has-[a:focus-visible]:bg-muted/60" empty={emptyState} />
          </div>
          <div className="border-t md:hidden">
            {data.items.length === 0 ? (
              emptyState
            ) : (
              <ul className="divide-y">
                {data.items.map((l) => (
                  <li key={l._id}>
                    <Link
                      href={`/payment-links/${l._id}`}
                      className="flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-muted/50 focus-visible:bg-muted/60 focus-visible:outline-none"
                    >
                      <LinkThumb link={l} />
                      <span className="grid min-w-0 flex-1 gap-0.5">
                        <span className="truncate font-medium">{l.title}</span>
                        <span className="truncate text-xs text-muted-foreground">
                          <span className="figure">{priceLabel(l)}</span> · {paymentsLabel(l)}
                        </span>
                      </span>
                      <span className="grid justify-items-end gap-1">
                        <span className="font-medium figure">{formatNaira(l.collectedKobo)}</span>
                        <LinkStateBadge link={l} />
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}

      {data.total > 0 && <DataTablePagination table={table} pageSizes={PAGE_SIZES} noun="links" />}
    </div>
  )
}

/** The link's cover picture, or a link icon when it has none. */
function LinkThumb({ link }: { link: PaymentLink }) {
  const cover = link.images?.[0]
  if (!cover) {
    return (
      <span className="grid size-10 shrink-0 place-items-center rounded-[12px] bg-muted text-muted-foreground" aria-hidden>
        <Link2 className="size-4" />
      </span>
    )
  }
  // eslint-disable-next-line @next/next/no-img-element -- proxied upload
  return <img src={linkImageSrc(cover)} alt="" loading="lazy" className="size-10 shrink-0 rounded-[12px] bg-muted object-cover" />
}

/** The underlined status tabs at the top of a list card. */
export function UnderlineTabs<T extends string>({
  label,
  tabs,
  current,
  onSelect,
  className,
}: {
  label: string
  tabs: readonly (readonly [T, string])[]
  current: T
  onSelect: (tab: T) => void
  className?: string
}) {
  return (
    <nav aria-label={label} className={cn("overflow-x-auto px-4 pt-2 sm:px-6", className)}>
      <ul className="flex w-max min-w-full gap-1 border-b">
        {tabs.map(([t, text]) => {
          const active = current === t
          return (
            <li key={t}>
              <button
                type="button"
                aria-current={active ? "page" : undefined}
                onClick={() => !active && onSelect(t)}
                className={cn(
                  "-mb-px inline-flex h-10 items-center rounded-t-md border-b-2 px-3 text-sm whitespace-nowrap transition-colors duration-150 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                  active ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {text}
              </button>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
