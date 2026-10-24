"use client"

import { useMemo, useOptimistic, useState, useTransition } from "react"
import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { createColumnHelper, useTable, type PaginationState, type Updater } from "@tanstack/react-table"
import { ArrowRight, RotateCw, SearchX, ShieldCheck } from "lucide-react"
import { DataTable, dataTableFeatures, type DataTableFeatures } from "@/components/data-table/data-table"
import { DataTablePagination } from "@/components/data-table/data-table-pagination"
import { SearchBox } from "@/components/data-table/search-box"
import { PeriodPicker } from "@/components/transactions/transactions-view"
import { RowsSkeleton } from "@/components/transactions/skeletons"
import { KindIcon, recipientBank, recipientName, TransferAmount, TransferStatusBadge } from "@/components/transfers/parts"
import { TransferSheet } from "@/components/transfers/transfer-sheet"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Spinner } from "@/components/ui/spinner"
import type { Transfer, TransferBatchList, TransferList } from "@/lib/api/types"
import {
  APPROVAL_TAB_LABELS,
  APPROVAL_TABS,
  APPROVALS_DEFAULT_PERIOD,
  parseApprovalQuery,
  type ApprovalQuery,
  type ApprovalTab,
} from "@/lib/approvals"
import { formatDate, formatShortDate, formatTime } from "@/lib/format"
import { periodLabel } from "@/lib/transactions"
import { DEFAULT_PAGE_SIZE, PAGE_SIZES } from "@/lib/transfers"
import { cn } from "@/lib/utils"
import { WaitingBatches } from "./waiting-batches"

type Patch = Record<string, string | undefined>

const helper = createColumnHelper<DataTableFeatures, Transfer>()

const resolve = <T,>(updater: Updater<T>, old: T) =>
  typeof updater === "function" ? (updater as (old: T) => T)(old) : updater

/** Where a transfer stands in its approvals: "Level 1 of 2, waiting for Ada", "Approved by Bola". */
function progress(t: Transfer) {
  const levels = t.approval?.levels ?? []
  if (t.status === "pending_approval") {
    const level = levels.find((l) => l.status === "waiting")
    const who = !level || level.any || !level.approvers.length ? "any approver" : level.approvers.map((a) => a.name).join(", ")
    return levels.length > 1 ? `Level ${level?.level ?? 1} of ${levels.length}, waiting for ${who}` : `Waiting for ${who}`
  }
  const by = t.decision?.by?.name
  if (t.status === "rejected") return by ? `Declined by ${by}` : "Declined"
  if (t.status === "cancelled") return "Cancelled before approval"
  if (levels.length > 1) return `All ${levels.length} levels approved`
  return by ? `Approved by ${by}` : "Approved"
}

type Props = {
  data: TransferList
  query: ApprovalQuery
  /** Waiting at any level, across the member's branches. */
  pendingCount: number
  /** Waiting at the member's level; null when they can't approve. */
  awaitingCount: number | null
  showBranch: boolean
  /** A transfer opened by link (?transfer=) that isn't on this page of the list. */
  linked: Transfer | null
  /** Bulk transfers with rows waiting for the member; null when they can't approve. */
  batches: TransferBatchList | null
}

export function ApprovalsView({ data, query, pendingCount, awaitingCount, showBranch, linked, batches }: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [pending, startTransition] = useTransition()
  const [refreshing, startRefresh] = useTransition()
  const [shown, setShown] = useOptimistic(query)
  const [openId, setOpenId] = useState<string | null>(query.transfer ?? null)
  const open = data.items.find((t) => t._id === openId) ?? (linked?._id === openId ? linked : null)

  function navigate(patch: Patch) {
    const params = new URLSearchParams(searchParams.toString())
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || value === "") params.delete(key)
      else params.set(key, value)
    }
    const qs = params.toString()
    startTransition(() => {
      setShown(parseApprovalQuery(Object.fromEntries(params)))
      router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
    })
  }

  function close() {
    setOpenId(null)
    if (query.transfer) navigate({ transfer: undefined })
  }

  const columns = useMemo(
    () =>
      helper.columns([
        helper.accessor("createdAt", {
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
          id: "recipient",
          header: "To",
          cell: ({ row }) => (
            <div className="grid min-w-44 gap-0.5">
              <button
                type="button"
                onClick={() => setOpenId(row.original._id)}
                className="w-fit text-left font-medium outline-none after:absolute after:inset-0 hover:underline focus-visible:underline"
              >
                {recipientName(row.original)}
              </button>
              <span className="truncate text-xs text-muted-foreground">{recipientBank(row.original)}</span>
            </div>
          ),
          meta: { label: "To" },
        }),
        helper.accessor((t) => t.createdBy?.name, {
          id: "createdBy",
          header: "Prepared by",
          cell: ({ getValue }) => <span className="whitespace-nowrap text-muted-foreground">{getValue() ?? "Unknown"}</span>,
          meta: { label: "Prepared by", className: "hidden lg:table-cell" },
        }),
        helper.accessor((t) => t.branch?.name, {
          id: "branch",
          header: "From",
          cell: ({ getValue }) => <span className="whitespace-nowrap">{getValue() ?? "Unknown"}</span>,
          meta: { label: "From" },
        }),
        helper.display({
          id: "progress",
          header: "Approvals",
          cell: ({ row }) => (
            <div className="flex min-w-48 flex-wrap items-center gap-1.5">
              <span className="text-muted-foreground">{progress(row.original)}</span>
              {row.original.canApprove && <Badge variant="warning">Needs you</Badge>}
            </div>
          ),
          meta: { label: "Approvals" },
        }),
        helper.accessor("status", {
          header: "Status",
          cell: ({ getValue }) => <TransferStatusBadge status={getValue()} />,
          meta: { label: "Status", className: "hidden xl:table-cell" },
        }),
        helper.accessor("amountKobo", {
          header: "Amount",
          cell: ({ getValue }) => <TransferAmount kobo={getValue()} />,
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

  const filtered = !!query.q || query.period !== APPROVALS_DEFAULT_PERIOD
  const emptyState = (
    <Empty className="min-h-80 border-0">
      <EmptyHeader>
        <EmptyMedia variant="icon">{filtered ? <SearchX aria-hidden /> : <ShieldCheck aria-hidden />}</EmptyMedia>
        <EmptyTitle>{filtered ? "No matches" : query.tab === "pending" ? "Nothing waiting for approval" : `Nothing ${APPROVAL_TAB_LABELS[query.tab].toLowerCase()} yet`}</EmptyTitle>
        <EmptyDescription>
          {query.q ? (
            <>Nothing matches &ldquo;{query.q}&rdquo; for {periodLabel(query).toLowerCase()}.</>
          ) : filtered ? (
            <>Nothing here for {periodLabel(query).toLowerCase()}.</>
          ) : query.tab === "pending" ? (
            "Transfers that need someone's approval show here until they're approved or declined."
          ) : query.tab === "approved" ? (
            "Transfers that went through approval and were sent show here."
          ) : (
            "Transfers an approver declined show here, with their reason."
          )}
        </EmptyDescription>
      </EmptyHeader>
      {filtered && (
        <EmptyContent>
          <Button variant="outline" onClick={() => navigate({ q: undefined, period: undefined, from: undefined, to: undefined, page: undefined })}>
            Clear filters
          </Button>
        </EmptyContent>
      )}
    </Empty>
  )

  return (
    <div className="grid gap-6" aria-busy={pending}>
      <p role="status" aria-live="polite" className="sr-only">
        {pending ? "Loading approvals" : ""}
      </p>

      <div className={cn("grid gap-4", awaitingCount !== null && "sm:grid-cols-2")}>
        <Tile label="Total pending" value={pendingCount} note={pendingCount === 1 ? "transfer waiting for approval" : "transfers waiting for approval"} />
        {awaitingCount !== null && (
          <Tile
            label="Waiting for you"
            value={awaitingCount}
            note={awaitingCount === 0 ? "Nothing at your level right now" : "at your approval level"}
            href={awaitingCount > 0 ? "/transfers?tab=awaiting" : undefined}
          />
        )}
      </div>

      {batches && <WaitingBatches data={batches} showBranch={showBranch} />}

      <div className="surface overflow-hidden">
        <nav aria-label="Approval status" className="overflow-x-auto px-4 pt-2 sm:px-6">
          <ul className="flex w-max min-w-full gap-1 border-b">
            {APPROVAL_TABS.map((t) => {
              const active = shown.tab === t
              return (
                <li key={t}>
                  <button
                    type="button"
                    aria-current={active ? "page" : undefined}
                    onClick={() => !active && navigate({ tab: t === "pending" ? undefined : (t as ApprovalTab), page: undefined })}
                    className={cn(
                      "-mb-px inline-flex h-10 items-center gap-1.5 rounded-t-md border-b-2 px-3 text-sm whitespace-nowrap transition-colors duration-150 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                      active ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {APPROVAL_TAB_LABELS[t]}
                    {t === "pending" && pendingCount > 0 && (
                      <span className="grid h-5 min-w-5 place-items-center rounded-full bg-warning-subtle px-1.5 text-xs text-warning-foreground figure">
                        {pendingCount}
                      </span>
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        </nav>

        <div className="flex flex-wrap items-center gap-2 px-4 py-3 sm:px-6">
          <SearchBox
            id="approval-search"
            label="Search approvals"
            placeholder="Recipient, account number or reference"
            value={query.q ?? ""}
            onSearch={(q) => navigate({ q, page: undefined })}
            className="w-full sm:w-80"
          />
          <PeriodPicker query={shown} onChange={navigate} defaultPeriod={APPROVALS_DEFAULT_PERIOD} />
          <Button
            variant="ghost"
            size="icon-sm"
            className="ml-auto"
            aria-label="Refresh"
            disabled={refreshing}
            onClick={() => startRefresh(() => router.refresh())}
          >
            {refreshing ? <Spinner /> : <RotateCw aria-hidden />}
          </Button>
        </div>

        {pending ? (
          <div className="border-t">
            <RowsSkeleton rows={Math.min(Math.max(data.items.length, 5), 10)} showBranch={showBranch} />
          </div>
        ) : (
          <>
            <div className="hidden border-t md:block">
              <DataTable table={table} caption="Fund approvals" rowClassName="relative cursor-pointer has-[button:focus-visible]:bg-muted/60" empty={emptyState} />
            </div>
            <div className="border-t md:hidden">
              {data.items.length === 0 ? (
                emptyState
              ) : (
                <ul className="divide-y">
                  {data.items.map((t) => (
                    <li key={t._id}>
                      <button
                        type="button"
                        onClick={() => setOpenId(t._id)}
                        className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-muted/50 focus-visible:bg-muted/60 focus-visible:outline-none"
                      >
                        <KindIcon transfer={t} />
                        <span className="grid min-w-0 flex-1 gap-0.5">
                          <span className="truncate font-medium">{recipientName(t)}</span>
                          <span className="truncate text-xs text-muted-foreground">{progress(t)}</span>
                          <span className="truncate text-xs text-muted-foreground">
                            {formatShortDate(t.createdAt)}, {formatTime(t.createdAt)}
                            {showBranch && t.branch && ` · ${t.branch.name}`}
                          </span>
                        </span>
                        <span className="grid justify-items-end gap-1">
                          <TransferAmount kobo={t.amountKobo} />
                          {t.canApprove ? <Badge variant="warning">Needs you</Badge> : t.status !== "pending_approval" && <TransferStatusBadge status={t.status} />}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}

        {data.total > 0 && <DataTablePagination table={table} pageSizes={PAGE_SIZES} noun="transfers" />}

        <TransferSheet transfer={open} onClose={close} />
      </div>
    </div>
  )
}

function Tile({ label, value, note, href }: { label: string; value: number; note: string; href?: string }) {
  const body = (
    <>
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="type-display text-3xl figure">{value}</p>
      <p className="flex items-center gap-1 text-sm text-muted-foreground">
        {note}
        {href && <ArrowRight className="size-3.5 transition-transform duration-200 group-hover:translate-x-0.5" aria-hidden />}
      </p>
    </>
  )
  return href ? (
    <Link href={href} className="surface group grid gap-1 p-5 transition-colors hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none sm:p-6">
      {body}
    </Link>
  ) : (
    <div className="surface grid gap-1 p-5 sm:p-6">{body}</div>
  )
}
