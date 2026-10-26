"use client"

import { useMemo, useOptimistic, useState, useTransition } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { createColumnHelper, useTable, type PaginationState, type Updater } from "@tanstack/react-table"
import { ArrowUpRight, RotateCw, SearchX, X } from "lucide-react"
import { toast } from "sonner"
import { actOnBatch } from "@/app/(dashboard)/transfers/actions"
import { useStepUp } from "@/components/security/step-up-dialog"
import { DataTable, dataTableFeatures, type DataTableFeatures } from "@/components/data-table/data-table"
import { DataTablePagination } from "@/components/data-table/data-table-pagination"
import { SearchBox } from "@/components/data-table/search-box"
import { RowsSkeleton } from "@/components/transactions/skeletons"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Spinner } from "@/components/ui/spinner"
import type { Transfer, TransferBatch, TransferList } from "@/lib/api/types"
import { formatDate, formatNaira, formatShortDate, formatTime } from "@/lib/format"
import { DEFAULT_PAGE_SIZE, PAGE_SIZES, parseTransferQuery, TAB_LABELS, TABS, type TransferQuery, type TransferTab } from "@/lib/transfers"
import { cn } from "@/lib/utils"
import { KindIcon, recipientBank, recipientName, TransferAmount, TransferStatusBadge } from "./parts"
import { TransferSheet } from "./transfer-sheet"

type Patch = Record<string, string | undefined>

const helper = createColumnHelper<DataTableFeatures, Transfer>()

const resolve = <T,>(updater: Updater<T>, old: T) =>
  typeof updater === "function" ? (updater as (old: T) => T)(old) : updater

type Props = {
  data: TransferList
  query: TransferQuery
  /** Hides "Needs your approval" for members who can't approve. */
  canApprove: boolean
  awaitingCount: number
  showBranch: boolean
  /** The bulk transfer the list is narrowed to (?batch=). */
  batch: TransferBatch | null
  /** A transfer opened by link (?transfer=) that isn't on this page of the list. */
  linked: Transfer | null
  /** Shown in the empty state for members who can send. */
  newTransfer?: React.ReactNode
}

export function TransfersView({ data, query, canApprove, awaitingCount, showBranch, batch, linked, newTransfer }: Props) {
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
      setShown(parseTransferQuery(Object.fromEntries(params)))
      router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
    })
  }

  function close() {
    setOpenId(null)
    // A link's ?transfer= shouldn't reopen the sheet on refresh.
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
        helper.accessor("status", {
          header: "Status",
          cell: ({ getValue }) => <TransferStatusBadge status={getValue()} />,
          meta: { label: "Status" },
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

  const tabs = TABS.filter((t) => t !== "awaiting" || canApprove)
  const firstEver = data.total === 0 && query.tab === "all" && !query.q && !query.batch

  const emptyState = firstEver ? (
    <Empty className="min-h-80 border-0">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <ArrowUpRight aria-hidden />
        </EmptyMedia>
        <EmptyTitle>No transfers yet</EmptyTitle>
        <EmptyDescription>Pay suppliers and staff, or move money between your branches. Every transfer shows here.</EmptyDescription>
      </EmptyHeader>
      {newTransfer && <EmptyContent>{newTransfer}</EmptyContent>}
    </Empty>
  ) : (
    <Empty className="min-h-80 border-0">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <SearchX aria-hidden />
        </EmptyMedia>
        <EmptyTitle>{query.tab === "awaiting" ? "Nothing waiting for you" : "No matches"}</EmptyTitle>
        <EmptyDescription>
          {query.q ? (
            <>Nothing matches &ldquo;{query.q}&rdquo; here.</>
          ) : query.tab === "awaiting" ? (
            "Transfers that need your approval show here."
          ) : (
            `No transfers are ${TAB_LABELS[query.tab].toLowerCase()} right now.`
          )}
        </EmptyDescription>
      </EmptyHeader>
      {(query.q || query.tab !== "all") && (
        <EmptyContent>
          <Button variant="outline" onClick={() => navigate({ tab: undefined, q: undefined, page: undefined })}>
            Show all transfers
          </Button>
        </EmptyContent>
      )}
    </Empty>
  )

  return (
    <div className="grid gap-6" aria-busy={pending}>
      <p role="status" aria-live="polite" className="sr-only">
        {pending ? "Loading transfers" : ""}
      </p>

      {batch && <BatchBanner batch={batch} onClear={() => navigate({ batch: undefined, page: undefined })} />}

      <div className="surface overflow-hidden">
        <nav aria-label="Transfer status" className="overflow-x-auto px-4 pt-2 sm:px-6">
          <ul className="flex w-max min-w-full gap-1 border-b">
            {tabs.map((t) => {
              const active = shown.tab === t
              return (
                <li key={t}>
                  <button
                    type="button"
                    aria-current={active ? "page" : undefined}
                    onClick={() => !active && navigate({ tab: t === "all" ? undefined : (t as TransferTab), page: undefined })}
                    className={cn(
                      "-mb-px inline-flex h-10 items-center gap-1.5 rounded-t-md border-b-2 px-3 text-sm whitespace-nowrap transition-colors duration-150 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                      active ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {TAB_LABELS[t]}
                    {t === "awaiting" && awaitingCount > 0 && (
                      <span className="grid h-5 min-w-5 place-items-center rounded-full bg-warning-subtle px-1.5 text-xs text-warning-foreground figure">
                        {awaitingCount}
                      </span>
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        </nav>

        <div className="flex items-center gap-2 px-4 py-3 sm:px-6">
          <SearchBox
            id="transfer-search"
            label="Search transfers"
            placeholder="Recipient, account number or reference"
            value={query.q ?? ""}
            onSearch={(q) => navigate({ q, page: undefined })}
            className="flex-1 sm:w-96 sm:flex-none"
          />
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
              <DataTable table={table} caption="Transfers" rowClassName="relative cursor-pointer has-[button:focus-visible]:bg-muted/60" empty={emptyState} />
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
                          <span className="truncate text-xs text-muted-foreground">
                            {formatShortDate(t.createdAt)}, {formatTime(t.createdAt)}
                            {showBranch && t.branch && ` · ${t.branch.name}`}
                          </span>
                        </span>
                        <span className="grid justify-items-end gap-1">
                          <TransferAmount kobo={t.amountKobo} />
                          {t.status !== "success" && <TransferStatusBadge status={t.status} />}
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

/** A bulk transfer: totals, progress and approve or reject everything still waiting. */
function BatchBanner({ batch, onClear }: { batch: TransferBatch; onClear: () => void }) {
  const [busy, setBusy] = useState<"approve" | "reject" | "cancel" | null>(null)
  const stepUp = useStepUp()
  const waiting = batch.statusCounts.pending_approval
  const approvable = batch.items.filter((i) => i.canApprove).length
  const cancellable = batch.items.filter((i) => i.canCancel).length
  const sent = batch.statusCounts.success
  const failed = batch.statusCounts.failed + batch.statusCounts.rejected + batch.statusCounts.cancelled

  async function act(action: "approve" | "reject" | "cancel") {
    setBusy(action)
    const result =
      action === "approve"
        ? await stepUp.confirm("batch.approve", { id: batch._id }, (proof) => actOnBatch(batch._id, action, undefined, proof))
        : await actOnBatch(batch._id, action)
    setBusy(null)
    if (!result) return
    if (!result.ok) return toast.error(result.error)
    const stillWaiting = result.data.statusCounts.pending_approval
    toast.success(
      action === "approve"
        ? stillWaiting > 0
          ? `Approved at your level. ${stillWaiting} transfers now go to the next approver.`
          : `Approved. ${waiting} transfers are on the way.`
        : action === "reject" ? "Rejected. The money is available again." : "Bulk transfer cancelled.",
    )
  }

  return (
    <section className="surface grid gap-4 p-5 sm:p-6">
      {stepUp.dialog}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="grid gap-1">
          <p className="text-sm text-muted-foreground">Bulk transfer{batch.title ? `, ${batch.title}` : ""}</p>
          <p className="type-display text-3xl figure">{formatNaira(batch.amountKobo)}</p>
          <p className="text-sm text-muted-foreground">
            {batch.count} transfers, <span className="figure">{formatNaira(batch.feeKobo)}</span> in fees, {formatDate(batch.createdAt)}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onClear}>
          Show all transfers
          <X data-icon="inline-end" aria-hidden />
        </Button>
      </div>
      <p className="text-sm">
        {waiting > 0 && `${waiting} waiting for approval. `}
        {sent > 0 && `${sent} sent. `}
        {failed > 0 && `${failed} not sent.`}
      </p>
      {(approvable > 0 || cancellable > 0) && (
        <div className="flex flex-wrap gap-2">
          {approvable > 0 && (
            <>
              <Button disabled={!!busy} onClick={() => act("approve")}>
                {busy === "approve" && <Spinner />}
                Approve all {approvable}
              </Button>
              <Button variant="outline" disabled={!!busy} onClick={() => act("reject")}>
                {busy === "reject" && <Spinner />}
                Reject all
              </Button>
            </>
          )}
          {cancellable > 0 && (
            <Button variant="outline" disabled={!!busy} onClick={() => act("cancel")}>
              {busy === "cancel" && <Spinner />}
              Cancel bulk transfer
            </Button>
          )}
        </div>
      )}
    </section>
  )
}
