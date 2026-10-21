import { BandHeaderSkeleton, BusinessesTableSkeleton } from "@/components/admin/admin-skeletons"
import { Skeleton } from "@/components/ui/skeleton"

export default function Loading() {
  return (
    <>
      <BandHeaderSkeleton back />
      <div className="grid gap-6" aria-busy aria-label="Loading activity">
        <Skeleton className="h-44 rounded-2xl" />
        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          <Skeleton className="h-80 rounded-2xl" />
          <div className="grid gap-6">
            <Skeleton className="h-40 rounded-2xl" />
            <Skeleton className="h-36 rounded-2xl" />
          </div>
        </div>
        <BusinessesTableSkeleton tabs />
      </div>
    </>
  )
}
