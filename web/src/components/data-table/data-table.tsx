"use client"

import {
  columnVisibilityFeature,
  rowPaginationFeature,
  rowSortingFeature,
  tableFeatures,
  type ReactTable,
  type RowData,
} from "@tanstack/react-table"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { cn } from "@/lib/utils"

export type DataTableColumnMeta = {
  /** Name used in the column menu and for screen readers when the header is an icon or empty. */
  label: string
  /** Classes for both the header and the cells, e.g. responsive hiding or alignment. */
  className?: string
}

/**
 * The feature set every data table in the app uses. Sorting and pagination run on the server
 * (manualSorting / manualPagination), so no client row models are registered.
 */
export const dataTableFeatures = tableFeatures({
  rowSortingFeature,
  rowPaginationFeature,
  columnVisibilityFeature,
  columnMeta: {} as DataTableColumnMeta,
})

export type DataTableFeatures = typeof dataTableFeatures
export type DataTableInstance<TData extends RowData> = ReactTable<DataTableFeatures, TData>

const ARIA_SORT = { asc: "ascending", desc: "descending" } as const

/**
 * Renders a table instance with shadcn's Table primitives: aria-sort on
 * sortable headers, a caption for screen readers and an empty state spanning every column.
 */
export function DataTable<TData extends RowData>({
  table,
  caption,
  empty,
  busy = false,
  rowClassName,
}: {
  table: DataTableInstance<TData>
  caption: string
  empty: React.ReactNode
  /** Dims the rows while a new page of results loads. */
  busy?: boolean
  rowClassName?: string
}) {
  const rows = table.getRowModel().rows
  const columnCount = table.getVisibleLeafColumns().length

  return (
    <Table aria-busy={busy} className="min-w-144">
      <caption className="sr-only">{caption}</caption>
      <TableHeader className="bg-muted/60">
        {table.getHeaderGroups().map((group) => (
          <TableRow key={group.id} className="hover:bg-transparent">
            {group.headers.map((header) => {
              const sorted = header.column.getIsSorted()
              return (
                <TableHead
                  key={header.id}
                  scope="col"
                  aria-sort={header.column.getCanSort() ? (sorted ? ARIA_SORT[sorted] : "none") : undefined}
                  className={cn(
                    "h-11 text-xs font-medium text-muted-foreground first:pl-4 last:pr-4 sm:first:pl-6 sm:last:pr-6",
                    header.column.columnDef.meta?.className,
                  )}
                >
                  {header.isPlaceholder ? null : <table.FlexRender header={header} />}
                </TableHead>
              )
            })}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody className={cn("transition-opacity duration-150", busy && "opacity-60")}>
        {rows.length === 0 ? (
          <TableRow className="hover:bg-transparent">
            <TableCell colSpan={columnCount} className="p-0">
              {empty}
            </TableCell>
          </TableRow>
        ) : (
          rows.map((row) => (
            <TableRow key={row.id} className={rowClassName}>
              {row.getVisibleCells().map((cell) => (
                <TableCell
                  key={cell.id}
                  className={cn("py-3 first:pl-4 last:pr-4 sm:first:pl-6 sm:last:pr-6", cell.column.columnDef.meta?.className)}
                >
                  <table.FlexRender cell={cell} />
                </TableCell>
              ))}
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  )
}
