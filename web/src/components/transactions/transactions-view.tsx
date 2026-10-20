"use client"

import { useMemo, useOptimistic, useState, useTransition } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { createColumnHelper, useTable, type PaginationState, type Updater } from "@tanstack/react-table"
import { ArrowDownLeft, CalendarRange, Check, ChevronDown, RotateCw, SearchX, X } from "lucide-react"
import { CopyButton, shareText } from "@/components/accounts/copy-button"
import { DataTable, dataTableFeatures, type DataTableFeatures } from "@/components/data-table/data-table"
import { DataTablePagination } from "@/components/data-table/data-table-pagination"
import { SearchBox } from "@/components/data-table/search-box"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import type { Transaction, TransactionList, TransactionSummary } from "@/lib/api/types"
import { formatDate, formatShortDate, formatTime } from "@/lib/format"
import {
  DEFAULT_PAGE_SIZE,
  DEFAULT_PERIOD,
  DIRECTION_LABELS,
  hasFilters,
  PAGE_SIZES,
  PERIOD_LABELS,
  PERIODS,
  parseTransactionQuery,
  periodLabel,
  STATUS_LABELS,
  todayInLagos,
  TRANSACTION_STATUSES,
  type Period,
  type TransactionQuery,
} from "@/lib/transactions"
import { cn } from "@/lib/utils"
import { Amount, DirectionIcon, payerBank, payerName, TransactionStatusBadge } from "./parts"
import { RowsSkeleton, SummarySkeleton } from "./skeletons"
import { SummaryCard } from "./summary-card"
import { TransactionSheet } from "./transaction-sheet"

type Patch = Record<string, string | undefined>

const helper = createColumnHelper<DataTableFeatures, Transaction>()

const resolve = <T,>(updater: Updater<T>, old: T) =>
  typeof updater === "function" ? (updater as (old: T) => T)(old) : updater

type Props = {
  data: TransactionList
  /** Totals for the period; null when they couldn't load. */
  summary: TransactionSummary | null
  query: TransactionQuery
  /** "All branches": each row says which branch the money arrived in. */
  showBranch: boolean
  /** A branch picked through the URL (not the sidebar), shown as a removable filter. */
  branchChip?: string
  /** "none": the business (or branch) has never had a transaction. "filtered": nothing matches the filters. */
  empty: "none" | "filtered"
  /** Account to share from the "no payments yet" state. */
  shareAccount?: { bankName?: string; accountName?: string; accountNumber: string }
}

export function TransactionsView({ data, summary, query, showBranch, branchChip, empty, shareAccount }: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [pending, startTransition] = useTransition()
  const [refreshing, startRefresh] = useTransition()
  // The filters show the new choice straight away; the data follows when the page arrives.
  const [shown, setShown] = useOptimistic(query)
  const [openId, setOpenId] = useState<string | null>(null)
  const open = data.items.find((t) => t._id === openId) ?? null

  /** Merges `patch` into the URL (undefined removes a key) and loads the new view. */
  function navigate(patch: Patch) {
    const params = new URLSearchParams(searchParams.toString())
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || value === "") params.delete(key)
      else params.set(key, value)
    }
    const qs = params.toString()
    startTransition(() => {
      setShown(parseTransactionQuery(Object.fromEntries(params)))
      router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
    })
  }

  const columns = useMemo(
    () =>
      helper.columns([
        helper.accessor("occurredAt", {
          header: "Date",
          cell: ({ getValue }) => (
            <div className="grid gap-0.5 whitespace-nowrap">
              <span className="figure">{formatDate(getValue())}</span>
              <span className="text-xs text-muted-foreground figure">{formatTime(getValue())}</span>
            </div>
          ),
          meta: { label: "Date" },
        }),
        helper.display({
          id: "payer",
          header: "From / to",
          cell: ({ row }) => (
            <div className="grid min-w-44 gap-0.5">
              <button
                type="button"
                onClick={() => setOpenId(row.original._id)}
                className="w-fit text-left font-medium outline-none after:absolute after:inset-0 hover:underline focus-visible:underline"
              >
                {payerName(row.original)}
              </button>
              <span className="truncate text-xs text-muted-foreground">{payerBank(row.original)}</span>
            </div>
          ),
          meta: { label: "From / to" },
        }),
        helper.accessor("narration", {
          header: "Narration",
          cell: ({ getValue }) =>
            getValue() ? (
              <span className="line-clamp-2 max-w-64 text-muted-foreground">{getValue()}</span>
            ) : (
              <span className="text-muted-foreground/70">None</span>
            ),
          meta: { label: "Narration", className: "hidden lg:table-cell" },
        }),
        helper.accessor((t) => t.branch?.name, {
          id: "branch",
          header: "Branch",
          cell: ({ getValue }) => <span className="whitespace-nowrap">{getValue() ?? "Unknown"}</span>,
          meta: { label: "Branch" },
        }),
        helper.accessor("status", {
          header: "Status",
          cell: ({ getValue }) => <TransactionStatusBadge status={getValue()} />,
          meta: { label: "Status" },
        }),
        helper.accessor("amountKobo", {
          header: "Amount",
          cell: ({ row }) => <Amount tx={row.original} />,
          meta: { label: "Amount", className: "text-right" },
        }),
      ]),
    [],
  )

  const pagination: PaginationState = useMemo(
    () => ({ pageIndex: query.page - 1, pageSize: query.size }),
    [query.page, query.size],
  )

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

  const filtered = hasFilters(query)
  const emptyState =
    empty === "none" ? (
      <Empty className="min-h-80 border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ArrowDownLeft aria-hidden />
          </EmptyMedia>
          <EmptyTitle>No payments yet</EmptyTitle>
          <EmptyDescription>
            Share your account number to get paid. Payments show here as soon as they arrive.
          </EmptyDescription>
        </EmptyHeader>
        {shareAccount && (
          <EmptyContent>
            <CopyButton
              value={shareText(shareAccount)}
              message="Account details copied"
              label="Share account details"
              variant="default"
              size="default"
            >
              Share account details
            </CopyButton>
          </EmptyContent>
        )}
      </Empty>
    ) : (
      <Empty className="min-h-80 border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <SearchX aria-hidden />
          </EmptyMedia>
          <EmptyTitle>No matches</EmptyTitle>
          <EmptyDescription>
            {filtered
              ? <>Nothing matches {query.q ? <>&ldquo;{query.q}&rdquo;</> : "these filters"} for {periodLabel(query).toLowerCase()}.</>
              : <>No transactions for {periodLabel(query).toLowerCase()}.</>}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          {filtered ? (
            <Button variant="outline" onClick={() => navigate({ status: undefined, direction: undefined, q: undefined, page: undefined })}>
              Clear filters
            </Button>
          ) : (
            <Button variant="outline" onClick={() => navigate({ period: "all", from: undefined, to: undefined, page: undefined })}>
              Show all time
            </Button>
          )}
        </EmptyContent>
      </Empty>
    )

  return (
    <div className="grid gap-6" aria-busy={pending}>
      {/* Announced while a filter, search or page change loads; the skeletons below are decorative. */}
      <p role="status" aria-live="polite" className="sr-only">
        {pending ? "Loading transactions" : ""}
      </p>
      {pending ? <SummarySkeleton /> : <SummaryCard summary={summary} period={periodLabel(query)} />}

      <div className="surface overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 px-4 py-3 sm:px-6">
          <PeriodPicker query={shown} onChange={navigate} />
          <DirectionFilter value={shown.direction} onChange={(direction) => navigate({ direction, page: undefined })} />
          <Select
            value={shown.status ?? "all"}
            onValueChange={(v) => navigate({ status: v === "all" ? undefined : v, page: undefined })}
          >
            <SelectTrigger size="sm" className="w-36" aria-label="Status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {TRANSACTION_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {STATUS_LABELS[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {branchChip && (
            <Button variant="outline" size="sm" onClick={() => navigate({ branch: undefined, page: undefined })}>
              {branchChip}
              <X data-icon="inline-end" aria-hidden />
              <span className="sr-only">. Remove branch filter</span>
            </Button>
          )}
          <div className="flex w-full items-center gap-2 lg:ml-auto lg:w-auto">
            <SearchBox
              id="transaction-search"
              label="Search transactions"
              placeholder="Name, account, reference or narration"
              value={query.q ?? ""}
              onSearch={(q) => navigate({ q, page: undefined })}
              className="flex-1 sm:w-80 sm:flex-none"
            />
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Refresh"
              disabled={refreshing}
              onClick={() => startRefresh(() => router.refresh())}
            >
              {refreshing ? <Spinner /> : <RotateCw aria-hidden />}
            </Button>
          </div>
        </div>

        {pending ? (
          <div className="border-t">
            <RowsSkeleton rows={Math.min(Math.max(data.items.length, 5), 10)} showBranch={showBranch} />
          </div>
        ) : (
          <>
            {/* md and up: the table. */}
            <div className="hidden border-t md:block">
              <DataTable
                table={table}
                caption="Transactions"
                rowClassName="relative cursor-pointer has-[button:focus-visible]:bg-muted/60"
                empty={emptyState}
              />
            </div>

            {/* Phones: stacked rows. */}
            <div className="border-t md:hidden">
              {data.items.length === 0 ? (
                emptyState
              ) : (
                <ul className="divide-y">
                  {data.items.map((tx) => (
                    <li key={tx._id}>
                      <button
                        type="button"
                        onClick={() => setOpenId(tx._id)}
                        className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-muted/50 focus-visible:bg-muted/60 focus-visible:outline-none"
                      >
                        <DirectionIcon tx={tx} />
                        <span className="grid min-w-0 flex-1 gap-0.5">
                          <span className="truncate font-medium">{payerName(tx)}</span>
                          <span className="truncate text-xs text-muted-foreground">
                            {formatShortDate(tx.occurredAt)}, {formatTime(tx.occurredAt)}
                            {showBranch && tx.branch && ` · ${tx.branch.name}`}
                          </span>
                        </span>
                        <span className="grid justify-items-end gap-1">
                          <Amount tx={tx} />
                          {tx.status !== "success" && <TransactionStatusBadge status={tx.status} />}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}

        {data.total > 0 && <DataTablePagination table={table} pageSizes={PAGE_SIZES} noun="transactions" />}

        <TransactionSheet tx={open} onClose={() => setOpenId(null)} />
      </div>
    </div>
  )
}

function DirectionFilter({ value, onChange }: { value?: string; onChange: (v: string | undefined) => void }) {
  const options: { value?: string; label: string }[] = [
    { label: "All" },
    { value: "credit", label: DIRECTION_LABELS.credit },
    { value: "debit", label: DIRECTION_LABELS.debit },
  ]
  return (
    <div role="group" aria-label="Money in or out" className="inline-flex h-8 items-center gap-0.5 rounded-full bg-muted p-0.5">
      {options.map((o) => {
        const active = value === o.value
        return (
          <button
            key={o.label}
            type="button"
            aria-pressed={active}
            onClick={() => !active && onChange(o.value)}
            className={cn(
              "h-7 rounded-full px-3 text-xs font-medium whitespace-nowrap transition-colors duration-150 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
              active ? "bg-card text-foreground shadow-surface" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

/** Preset periods, or a custom range of Lagos calendar days. */
function PeriodPicker({ query, onChange }: { query: TransactionQuery; onChange: (patch: Patch) => void }) {
  const [open, setOpen] = useState(false)
  const [from, setFrom] = useState(query.from ?? "")
  const [to, setTo] = useState(query.to ?? "")
  const today = todayInLagos()

  function choose(period: Period) {
    setOpen(false)
    onChange({ period: period === DEFAULT_PERIOD ? undefined : period, from: undefined, to: undefined, page: undefined })
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          setFrom(query.from ?? "")
          setTo(query.to ?? "")
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" aria-label={`Period: ${periodLabel(query)}`}>
          <CalendarRange data-icon="inline-start" aria-hidden />
          {periodLabel(query)}
          <ChevronDown data-icon="inline-end" className="text-muted-foreground" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 gap-0 p-1.5">
        <ul className="grid">
          {PERIODS.filter((p) => p !== "custom").map((p) => (
            <li key={p}>
              <button
                type="button"
                onClick={() => choose(p)}
                className="flex w-full items-center justify-between rounded-md px-2.5 py-2 text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
              >
                {PERIOD_LABELS[p]}
                {query.period === p && <Check className="size-4 text-primary" aria-label="Selected" />}
              </button>
            </li>
          ))}
        </ul>
        <form
          className="mt-1.5 grid gap-3 border-t px-2.5 pt-3 pb-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (!from && !to) return
            setOpen(false)
            onChange({ period: "custom", from: from || undefined, to: to || undefined, page: undefined })
          }}
        >
          <p className="text-xs font-medium text-muted-foreground">Custom range</p>
          <div className="grid grid-cols-2 gap-2">
            <div className="grid gap-1">
              <Label htmlFor="period-from" className="text-xs font-normal">
                From
              </Label>
              <Input id="period-from" type="date" max={to || today} value={from} onChange={(e) => setFrom(e.target.value)} className="h-8 px-2 text-xs" />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="period-to" className="text-xs font-normal">
                To
              </Label>
              <Input id="period-to" type="date" min={from || undefined} max={today} value={to} onChange={(e) => setTo(e.target.value)} className="h-8 px-2 text-xs" />
            </div>
          </div>
          <Button type="submit" size="sm" disabled={!from && !to}>
            Apply range
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  )
}
