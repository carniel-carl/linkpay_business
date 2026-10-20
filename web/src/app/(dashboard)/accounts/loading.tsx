import { PageHeaderSkeleton } from "@/components/common/page-skeleton"
import { Skeleton } from "@/components/ui/skeleton"

export default function Loading() {
  return (
    <div aria-busy aria-label="Loading accounts">
      <PageHeaderSkeleton />
      <div className="surface overflow-hidden">
        <div className="grid gap-2 border-b p-6 sm:px-8">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-11 w-56" />
        </div>
        {Array.from({ length: 2 }, (_, i) => (
          <div key={i} className="flex h-16 items-center gap-6 border-b px-5 last:border-0 sm:px-8">
            <div className="grid flex-1 gap-1.5">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-44" />
            </div>
            <Skeleton className="hidden h-4 w-28 md:block" />
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-5 w-16" />
          </div>
        ))}
      </div>
    </div>
  )
}
