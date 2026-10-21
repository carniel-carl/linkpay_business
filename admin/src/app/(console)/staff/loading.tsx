import { BandHeaderSkeleton } from "@/components/admin/admin-skeletons"
import { Skeleton } from "@/components/ui/skeleton"

export default function Loading() {
  return (
    <>
      <BandHeaderSkeleton />
      <div className="grid gap-8">
        <Skeleton className="h-72 rounded-2xl" />
        <Skeleton className="h-36 rounded-2xl" />
      </div>
    </>
  )
}
