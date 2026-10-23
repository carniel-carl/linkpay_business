"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { createColumnHelper, useTable, type PaginationState, type Updater } from "@tanstack/react-table"
import { BookUser, Ellipsis, Pencil, SearchX, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { deleteBeneficiary, renameBeneficiary } from "@/app/(dashboard)/beneficiaries/actions"
import { DataTable, dataTableFeatures, type DataTableFeatures } from "@/components/data-table/data-table"
import { DataTablePagination } from "@/components/data-table/data-table-pagination"
import { SearchBox } from "@/components/data-table/search-box"
import { useUrlState } from "@/components/payment-links/links-view"
import { RowsSkeleton } from "@/components/transactions/skeletons"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import type { Beneficiary, BeneficiaryList, PayoutListRef } from "@/lib/api/types"
import { formatDate } from "@/lib/format"
import { DEFAULT_PAGE_SIZE, MAX_NICKNAME, PAGE_SIZES, parseBeneficiaryQuery, type BeneficiaryQuery } from "@/lib/payouts"

const helper = createColumnHelper<DataTableFeatures, Beneficiary>()
const resolve = <T,>(updater: Updater<T>, old: T) => (typeof updater === "function" ? (updater as (old: T) => T)(old) : updater)

type Pending = { kind: "rename" | "delete"; beneficiary: Beneficiary } | null

/** The address book: search, most recently paid first, rename and delete. */
export function BeneficiariesView({
  data,
  query,
  canManage,
  addButton,
}: {
  data: BeneficiaryList
  query: BeneficiaryQuery
  canManage: boolean
  addButton?: React.ReactNode
}) {
  const { pending, navigate } = useUrlState(query, parseBeneficiaryQuery)
  const [acting, setActing] = useState<Pending>(null)

  const columns = useMemo(
    () =>
      helper.columns([
        helper.accessor("accountName", {
          header: "Beneficiary",
          cell: ({ row }) => <NameCell beneficiary={row.original} />,
          meta: { label: "Beneficiary" },
        }),
        helper.accessor("accountNumber", {
          header: "Account",
          cell: ({ row }) => (
            <span className="grid gap-0.5 whitespace-nowrap">
              <span className="font-mono">{row.original.accountNumber}</span>
              <span className="text-xs text-muted-foreground">{row.original.bankName ?? "Bank"}</span>
            </span>
          ),
          meta: { label: "Account" },
        }),
        helper.accessor("lastPaidAt", {
          header: "Last paid",
          cell: ({ getValue }) => <span className="whitespace-nowrap text-muted-foreground">{getValue() ? formatDate(getValue()!) : "Not yet"}</span>,
          meta: { label: "Last paid" },
        }),
        helper.accessor("createdAt", {
          header: "Saved",
          cell: ({ row }) => (
            <span className="grid gap-0.5 whitespace-nowrap">
              <span>{formatDate(row.original.createdAt)}</span>
              {row.original.createdBy && <span className="text-xs text-muted-foreground">by {row.original.createdBy.name}</span>}
            </span>
          ),
          meta: { label: "Saved", className: "hidden lg:table-cell" },
        }),
        helper.display({
          id: "actions",
          header: () => <span className="sr-only">Actions</span>,
          cell: ({ row }) => <RowMenu beneficiary={row.original} onAct={setActing} />,
          meta: { label: "Actions", className: "w-12 text-right" },
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
    state: { pagination, columnVisibility: { actions: canManage } },
    onPaginationChange: (updater) => {
      const next = resolve(updater, pagination)
      const sizeChanged = next.pageSize !== pagination.pageSize
      navigate({
        size: next.pageSize === DEFAULT_PAGE_SIZE ? undefined : String(next.pageSize),
        page: sizeChanged || next.pageIndex === 0 ? undefined : String(next.pageIndex + 1),
      })
    },
  })

  const emptyState = !query.q ? (
    <Empty className="min-h-80 border-0">
      <EmptyHeader>
        <EmptyMedia variant="icon" className="bg-pop-subtle text-foreground">
          <BookUser aria-hidden />
        </EmptyMedia>
        <EmptyTitle className="type-display text-2xl">No beneficiaries yet</EmptyTitle>
        <EmptyDescription>
          Save the people and businesses you pay often. Each account is checked with its bank once, then anyone on your team can add it to a payout
          list.
        </EmptyDescription>
      </EmptyHeader>
      {addButton && <EmptyContent>{addButton}</EmptyContent>}
    </Empty>
  ) : (
    <Empty className="min-h-80 border-0">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <SearchX aria-hidden />
        </EmptyMedia>
        <EmptyTitle>No matches</EmptyTitle>
        <EmptyDescription>No beneficiaries match &ldquo;{query.q}&rdquo;.</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button variant="outline" onClick={() => navigate({ q: undefined, page: undefined })}>
          Clear search
        </Button>
      </EmptyContent>
    </Empty>
  )

  return (
    <div className="surface overflow-hidden" aria-busy={pending}>
      <p role="status" aria-live="polite" className="sr-only">
        {pending ? "Loading beneficiaries" : ""}
      </p>
      <div className="px-4 py-3 sm:px-6">
        <SearchBox
          id="beneficiary-search"
          label="Search beneficiaries"
          placeholder="Search by name, nickname, account or bank"
          value={query.q ?? ""}
          onSearch={(q) => navigate({ q, page: undefined })}
          className="w-full sm:w-96"
        />
      </div>

      {pending ? (
        <div className="border-t">
          <RowsSkeleton rows={Math.min(Math.max(data.items.length, 5), 10)} showBranch={false} />
        </div>
      ) : (
        <>
          <div className="hidden border-t md:block">
            <DataTable table={table} caption="Saved beneficiaries" empty={emptyState} />
          </div>
          <div className="border-t md:hidden">
            {data.items.length === 0 ? (
              emptyState
            ) : (
              <ul className="divide-y">
                {data.items.map((b) => (
                  <li key={b._id} className="flex items-start gap-3 px-4 py-3.5">
                    <div className="grid min-w-0 flex-1 gap-1">
                      <NameCell beneficiary={b} />
                      <span className="truncate text-xs text-muted-foreground">
                        {b.bankName ?? "Bank"} · <span className="font-mono">{b.accountNumber}</span>
                        {b.lastPaidAt ? ` · paid ${formatDate(b.lastPaidAt)}` : ""}
                      </span>
                    </div>
                    {canManage && <RowMenu beneficiary={b} onAct={setActing} />}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}

      {data.total > 0 && <DataTablePagination table={table} pageSizes={PAGE_SIZES} noun="beneficiaries" />}

      <RenameDialog beneficiary={acting?.kind === "rename" ? acting.beneficiary : null} onClose={() => setActing(null)} />
      <DeleteDialog beneficiary={acting?.kind === "delete" ? acting.beneficiary : null} onClose={() => setActing(null)} />
    </div>
  )
}

function NameCell({ beneficiary: b }: { beneficiary: Beneficiary }) {
  return (
    <span className="grid min-w-0 gap-0.5">
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium break-words">{b.accountName}</span>
        {b.onLinkPay && <span className="rounded-md bg-brand-subtle px-1.5 py-0.5 text-[11px] font-medium text-primary">On LinkPay</span>}
      </span>
      {b.nickname && <span className="truncate text-xs text-muted-foreground">{b.nickname}</span>}
    </span>
  )
}

function RowMenu({ beneficiary, onAct }: { beneficiary: Beneficiary; onAct: (p: Pending) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${beneficiary.nickname ?? beneficiary.accountName}`}>
          <Ellipsis aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem onSelect={() => onAct({ kind: "rename", beneficiary })}>
          <Pencil aria-hidden />
          {beneficiary.nickname ? "Change nickname" : "Add a nickname"}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => onAct({ kind: "delete", beneficiary })}>
          <Trash2 aria-hidden />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The last beneficiary a dialog was opened for, so its content stays put while the dialog animates closed. */
function useLast(beneficiary: Beneficiary | null) {
  const [last, setLast] = useState(beneficiary)
  if (beneficiary && beneficiary !== last) setLast(beneficiary)
  return beneficiary ?? last
}

/** Only the nickname can change: the account and its name are what the bank confirmed. */
function RenameDialog({ beneficiary, onClose }: { beneficiary: Beneficiary | null; onClose: () => void }) {
  const shown = useLast(beneficiary)
  return (
    <Dialog open={!!beneficiary} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">{shown && <RenameForm key={shown._id} beneficiary={shown} onClose={onClose} />}</DialogContent>
    </Dialog>
  )
}

function RenameForm({ beneficiary, onClose }: { beneficiary: Beneficiary; onClose: () => void }) {
  const [value, setValue] = useState(beneficiary.nickname ?? "")
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState<"save" | "remove" | null>(null)

  async function save(next: string | null) {
    setBusy(next === null ? "remove" : "save")
    setError(undefined)
    const result = await renameBeneficiary(beneficiary._id, next)
    setBusy(null)
    if (!result.ok) return setError(result.fieldErrors?.nickname ?? result.error)
    toast.success(result.data.nickname ? `Nickname saved: ${result.data.nickname}.` : "Nickname removed.")
    onClose()
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{beneficiary.nickname ? "Change nickname" : "Add a nickname"}</DialogTitle>
        <DialogDescription>
          For {beneficiary.accountName}. Only your team sees it. Payments always carry the name the bank gave.
        </DialogDescription>
      </DialogHeader>
      <form
        id="rename-beneficiary"
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          save(value.trim() || null)
        }}
      >
        <Field data-invalid={!!error}>
          <FieldLabel htmlFor="beneficiary-rename">Nickname</FieldLabel>
          <Input
            id="beneficiary-rename"
            maxLength={MAX_NICKNAME}
            autoComplete="off"
            placeholder="Ada, cashier"
            value={value}
            aria-invalid={!!error}
            onChange={(e) => setValue(e.target.value)}
            autoFocus
          />
          {error ? <FieldError>{error}</FieldError> : <FieldDescription>Up to {MAX_NICKNAME} characters.</FieldDescription>}
        </Field>
      </form>
      <DialogFooter>
        {beneficiary.nickname && (
          <Button variant="ghost" className="sm:mr-auto" disabled={!!busy} onClick={() => save(null)}>
            {busy === "remove" && <Spinner />}
            Remove nickname
          </Button>
        )}
        <Button variant="outline" onClick={onClose} disabled={!!busy}>
          Cancel
        </Button>
        <Button type="submit" form="rename-beneficiary" disabled={!!busy}>
          {busy === "save" && <Spinner />}
          Save
        </Button>
      </DialogFooter>
    </>
  )
}

/** Asks first. A beneficiary a payout list still pays can't be deleted: the dialog then names the lists. */
function DeleteDialog({ beneficiary, onClose }: { beneficiary: Beneficiary | null; onClose: () => void }) {
  const shown = useLast(beneficiary)
  return (
    <AlertDialog open={!!beneficiary} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>{shown && <DeleteBody key={shown._id} beneficiary={shown} onClose={onClose} />}</AlertDialogContent>
    </AlertDialog>
  )
}

function DeleteBody({ beneficiary, onClose }: { beneficiary: Beneficiary; onClose: () => void }) {
  const [busy, setBusy] = useState(false)
  const [inUse, setInUse] = useState<PayoutListRef[] | null>(null)
  const [error, setError] = useState<string>()
  const name = beneficiary.nickname ?? beneficiary.accountName

  async function remove() {
    setBusy(true)
    setError(undefined)
    const result = await deleteBeneficiary(beneficiary._id)
    setBusy(false)
    if (!result.ok) return setError(result.error)
    if (!result.data.deleted) return setInUse(result.data.inUse)
    toast.success(`${name} is deleted. Past payments to them stay in Transfers.`)
    onClose()
  }

  if (inUse) {
    return (
      <>
        <AlertDialogHeader>
          <AlertDialogTitle>Take {name} off your payout lists first</AlertDialogTitle>
          <AlertDialogDescription>
            {inUse.length === 1 ? "A payout list still pays them." : `${inUse.length} payout lists still pay them.`} Edit{" "}
            {inUse.length === 1 ? "it" : "each one"} to take them off, then delete them here.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="grid gap-1.5 text-sm">
          {inUse.map((l) => (
            <li key={l._id}>
              <Link href={`/payout-lists/${l._id}/edit`} className="font-medium underline underline-offset-4 hover:text-primary">
                {l.title}
              </Link>
            </li>
          ))}
        </ul>
        <AlertDialogFooter>
          <AlertDialogCancel>Close</AlertDialogCancel>
        </AlertDialogFooter>
      </>
    )
  }

  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle>Delete {name}?</AlertDialogTitle>
        <AlertDialogDescription>
          {beneficiary.accountName}, {beneficiary.bankName ?? "Bank"} {beneficiary.accountNumber}. Past payments to them stay in Transfers. To pay them
          again you&apos;d save the account again.
        </AlertDialogDescription>
      </AlertDialogHeader>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <AlertDialogFooter>
        <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
        <AlertDialogAction
          variant="destructive"
          disabled={busy}
          onClick={(e) => {
            e.preventDefault()
            remove()
          }}
        >
          {busy && <Spinner />}
          Delete
        </AlertDialogAction>
      </AlertDialogFooter>
    </>
  )
}
