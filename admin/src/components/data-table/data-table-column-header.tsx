"use client"

import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react"
import type { CellData, Column, RowData } from "@tanstack/react-table"
import { cn } from "@/lib/utils"
import type { DataTableFeatures } from "./data-table"

/**
 * A sortable column header: one button that cycles the sort direction. The th carries aria-sort
 * (see DataTable), and the button's label says what a press will do.
 */
export function DataTableColumnHeader<TData extends RowData, TValue extends CellData>({
  column,
  title,
  className,
}: {
  column: Column<DataTableFeatures, TData, TValue>
  title: string
  className?: string
}) {
  if (!column.getCanSort()) return <span className={className}>{title}</span>

  const sorted = column.getIsSorted()
  const next = column.getNextSortingOrder()
  const Icon = sorted === "asc" ? ArrowUp : sorted === "desc" ? ArrowDown : ChevronsUpDown

  return (
    <button
      type="button"
      onClick={column.getToggleSortingHandler()}
      aria-label={`${title}. Sort ${next === "desc" ? "descending" : "ascending"}`}
      className={cn(
        "-ml-2 inline-flex h-8 items-center gap-1.5 rounded-lg px-2 transition-colors duration-150",
        "hover:bg-foreground/5 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
        sorted && "text-foreground",
        className,
      )}
    >
      {title}
      <Icon className={cn("size-3.5", !sorted && "opacity-60")} aria-hidden />
    </button>
  )
}
