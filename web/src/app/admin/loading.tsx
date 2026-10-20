import { BandHeaderSkeleton, BusinessesTableSkeleton } from "@/components/admin/admin-skeletons"
import { Skeleton } from "@/components/ui/skeleton"

export default function Loading() {
  return (
    <>
      <BandHeaderSkeleton />
      <div className="grid gap-6">
        <Skeleton className="h-28 rounded-2xl sm:h-32" />
        <BusinessesTableSkeleton />
      </div>
    </>
  )
}
