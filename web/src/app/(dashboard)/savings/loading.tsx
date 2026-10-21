import { PageHeaderSkeleton } from "@/components/common/page-skeleton"
import { Skeleton } from "@/components/ui/skeleton"

export default function Loading() {
  return (
    <div aria-busy aria-label="Loading savings">
      <PageHeaderSkeleton />
      <div className="grid gap-8">
        <div className="surface grid gap-2 p-6 sm:p-8">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-12 w-60" />
          <Skeleton className="h-4 w-32" />
        </div>
        <ul className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }, (_, i) => (
            <li key={i} className="surface grid gap-6 p-6">
              <div className="flex items-center gap-3.5">
                <Skeleton className="size-11 rounded-[13px]" />
                <Skeleton className="h-5 w-32" />
              </div>
              <div className="grid gap-3">
                <Skeleton className="h-8 w-40" />
                <Skeleton className="h-1.5 w-full" />
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
