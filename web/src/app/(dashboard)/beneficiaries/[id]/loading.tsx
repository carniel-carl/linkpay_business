import { PageHeaderSkeleton } from "@/components/common/page-skeleton"
import { Skeleton } from "@/components/ui/skeleton"

/** A beneficiary's page: the payments beside the account details. */
export default function Loading() {
  return (
    <div aria-busy aria-label="Loading beneficiary" className="grid gap-6">
      <PageHeaderSkeleton />
      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]" aria-hidden>
        <div className="surface grid gap-3 p-6 xl:order-last">
          <Skeleton className="h-4 w-20" />
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="grid grid-cols-[8.5rem_minmax(0,1fr)] gap-3">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-32" />
            </div>
          ))}
        </div>
        <div className="surface overflow-hidden">
          <div className="grid gap-2 p-5 sm:p-6">
            <Skeleton className="h-6 w-32" />
            <Skeleton className="h-4 w-72 max-w-full" />
          </div>
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="flex h-16 items-center gap-6 border-t px-5 sm:px-6">
              <div className="grid flex-1 gap-1.5">
                <Skeleton className="h-4 w-36" />
                <Skeleton className="h-3 w-48" />
              </div>
              <div className="grid justify-items-end gap-1.5">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-5 w-16" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
