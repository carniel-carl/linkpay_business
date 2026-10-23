import { PageHeaderSkeleton } from "@/components/common/page-skeleton"
import { Skeleton } from "@/components/ui/skeleton"

export default function Loading() {
  return (
    <div aria-busy aria-label="Loading payout lists" className="grid gap-6">
      <PageHeaderSkeleton />
      <ul className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3" aria-hidden>
        {[0, 1, 2].map((i) => (
          <li key={i} className="surface grid min-h-56 content-between gap-6 p-6">
            <div className="flex items-start gap-3.5">
              <Skeleton className="size-10 rounded-[12px]" />
              <div className="grid flex-1 gap-1.5">
                <Skeleton className="h-5 w-40" />
                <Skeleton className="h-3 w-28" />
              </div>
            </div>
            <div className="grid gap-1.5">
              <Skeleton className="h-8 w-44" />
              <Skeleton className="h-3 w-32" />
            </div>
            <div className="flex items-center justify-between border-t pt-4">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-8 w-24 rounded-full" />
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
