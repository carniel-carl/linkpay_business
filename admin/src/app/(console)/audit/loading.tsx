import { BandHeaderSkeleton } from "@/components/admin/admin-skeletons"
import { Skeleton } from "@/components/ui/skeleton"

export default function Loading() {
  return (
    <>
      <BandHeaderSkeleton />
      <div className="surface grid gap-6 p-5 sm:p-6" aria-busy aria-label="Loading the audit log">
        <Skeleton className="h-9 w-44 rounded-[10px]" />
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="flex gap-3">
            <Skeleton className="size-8 shrink-0 rounded-[30%]" />
            <div className="grid flex-1 gap-1.5">
              <Skeleton className="h-4 w-3/5" />
              <Skeleton className="h-3 w-2/5" />
            </div>
          </div>
        ))}
      </div>
    </>
  )
}
