import { PageHeaderSkeleton } from "@/components/common/page-skeleton"
import { Skeleton } from "@/components/ui/skeleton"

/** A list's page (and its editor): the title, then a card of rows. */
export default function Loading() {
  return (
    <div aria-busy aria-label="Loading payout list" className="grid gap-6">
      <PageHeaderSkeleton />
      <div className="surface overflow-hidden" aria-hidden>
        <div className="flex flex-wrap items-end justify-between gap-5 p-5 sm:p-7">
          <div className="grid gap-2">
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-4 w-80 max-w-full" />
          </div>
          <Skeleton className="h-10 w-full sm:w-96" />
        </div>
        <div className="h-10 border-t bg-muted/60" />
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="flex h-16 items-center gap-6 border-t px-5 sm:px-7">
            <div className="grid flex-1 gap-1.5">
              <Skeleton className="h-4 w-44" />
              <Skeleton className="h-3 w-36" />
            </div>
            <Skeleton className="hidden h-4 w-24 md:block" />
            <Skeleton className="h-9 w-40" />
          </div>
        ))}
      </div>
    </div>
  )
}
