import { BandHeaderSkeleton, BusinessesTableSkeleton } from "@/components/admin/admin-skeletons"
import { Skeleton } from "@/components/ui/skeleton"

export default function Loading() {
  return (
    <>
      <BandHeaderSkeleton />
      <div className="grid gap-6" aria-busy aria-label="Loading">
        <Skeleton className="h-36 rounded-2xl" />
        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
          <BusinessesTableSkeleton tabs />
          <Skeleton className="h-[28rem] rounded-2xl" />
        </div>
      </div>
    </>
  )
}
