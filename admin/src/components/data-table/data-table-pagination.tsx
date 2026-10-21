"use client"

import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { RowData } from "@tanstack/react-table"
import type { DataTableInstance } from "./data-table"

/** Range summary, rows-per-page picker and first/previous/next/last buttons. */
export function DataTablePagination<TData extends RowData>({
  table,
  pageSizes,
  noun,
}: {
  table: DataTableInstance<TData>
  pageSizes: readonly number[]
  /** Plural, e.g. "businesses". */
  noun: string
}) {
  const { pageIndex, pageSize } = table.state.pagination
  const total = table.getRowCount()
  const pages = Math.max(1, table.getPageCount())
  const from = total === 0 ? 0 : pageIndex * pageSize + 1
  const to = Math.min(total, (pageIndex + 1) * pageSize)

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-t px-4 py-3 text-sm sm:px-6">
      <p role="status" aria-live="polite" className="figure text-muted-foreground">
        {total === 0 ? `No ${noun}` : `${from} to ${to} of ${total} ${noun}`}
      </p>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <div className="flex items-center gap-2">
          <span id="rows-per-page" className="text-muted-foreground">
            Rows per page
          </span>
          <Select value={String(pageSize)} onValueChange={(v) => table.setPageSize(Number(v))}>
            <SelectTrigger size="sm" className="w-18" aria-labelledby="rows-per-page">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              {pageSizes.map((size) => (
                <SelectItem key={size} value={String(size)}>
                  {size}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <span className="figure text-muted-foreground">
          Page {pageIndex + 1} of {pages}
        </span>

        <nav aria-label="Pagination" className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon-sm"
            className="hidden sm:inline-flex"
            onClick={() => table.firstPage()}
            disabled={!table.getCanPreviousPage()}
            aria-label="First page"
          >
            <ChevronsLeft aria-hidden />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
            aria-label="Previous page"
          >
            <ChevronLeft aria-hidden />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
            aria-label="Next page"
          >
            <ChevronRight aria-hidden />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            className="hidden sm:inline-flex"
            onClick={() => table.lastPage()}
            disabled={!table.getCanNextPage()}
            aria-label="Last page"
          >
            <ChevronsRight aria-hidden />
          </Button>
        </nav>
      </div>
    </div>
  )
}
