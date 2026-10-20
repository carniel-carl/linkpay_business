import { Skeleton } from "@/components/ui/skeleton"

// Shapes of the Transactions page while it loads: used by loading.tsx on first load and by the
// view while a filter, search or page change is on its way, so both look the same.

export function SummarySkeleton() {
  return (
    <div className="surface grid gap-6 p-6 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end sm:p-8" aria-hidden>
      <div className="grid gap-2.5">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-11 w-64 max-w-full sm:h-12" />
      </div>
      <div className="flex gap-8">
        {[0, 1].map((i) => (
          <div key={i} className="grid gap-1.5">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-4 w-16" />
          </div>
        ))}
      </div>
    </div>
  )
}

export function FilterBarSkeleton() {
  return (
    <div className="flex flex-wrap items-center gap-2 px-4 py-3 sm:px-6" aria-hidden>
      <Skeleton className="h-8 w-32 rounded-full" />
      <Skeleton className="h-8 w-52 rounded-full" />
      <Skeleton className="h-8 w-36" />
      <Skeleton className="h-8 w-full lg:ml-auto lg:w-80" />
    </div>
  )
}

/** Table rows from md up (same columns as the real table), stacked rows on phones. */
export function RowsSkeleton({ rows = 8, showBranch = true }: { rows?: number; showBranch?: boolean }) {
  return (
    <div aria-hidden>
      <div className="hidden md:block">
        <div className="flex h-11 items-center gap-6 bg-muted/60 px-6">
          <Skeleton className="h-3 w-10" />
          <Skeleton className="h-3 w-10" />
        </div>
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex h-16 items-center gap-6 border-b px-6 last:border-0">
            <div className="grid w-24 shrink-0 gap-1.5">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-3 w-10" />
            </div>
            <div className="grid flex-1 gap-1.5">
              <Skeleton className="h-4 w-36" />
              <Skeleton className="h-3 w-44" />
            </div>
            <Skeleton className="hidden h-4 w-40 lg:block" />
            {showBranch && <Skeleton className="h-4 w-20" />}
            <Skeleton className="h-6 w-20" />
            <Skeleton className="h-4 w-24" />
          </div>
        ))}
      </div>
      <ul className="divide-y md:hidden">
        {Array.from({ length: rows }, (_, i) => (
          <li key={i} className="flex items-center gap-3 px-4 py-3.5">
            <Skeleton className="size-9 shrink-0 rounded-[10px]" />
            <div className="grid flex-1 gap-1.5">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-40" />
            </div>
            <Skeleton className="h-4 w-20" />
          </li>
        ))}
      </ul>
    </div>
  )
}
