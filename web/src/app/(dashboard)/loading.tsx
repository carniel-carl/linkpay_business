import { PageHeaderSkeleton } from "@/components/common/page-skeleton"
import { Skeleton } from "@/components/ui/skeleton"

export default function Loading() {
  return (
    <div aria-busy aria-label="Loading">
      <PageHeaderSkeleton />
      <div className="grid gap-10">
        <Skeleton className="h-56 rounded-xl" />
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <Skeleton className="h-72 rounded-xl" />
          <div className="grid content-start gap-8">
            <Skeleton className="h-40 rounded-xl" />
            <Skeleton className="h-24 rounded-xl" />
          </div>
        </div>
      </div>
    </div>
  )
}
