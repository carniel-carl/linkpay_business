import { BandHeaderSkeleton } from "@/components/admin/admin-skeletons"
import { Skeleton } from "@/components/ui/skeleton"

export default function Loading() {
  return (
    <>
      <BandHeaderSkeleton back />
      <div className="grid gap-6" aria-busy aria-label="Loading compliance">
        <Skeleton className="h-28 rounded-2xl" />
        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
          <Skeleton className="h-72 rounded-2xl" />
          <Skeleton className="h-96 rounded-2xl" />
        </div>
      </div>
    </>
  )
}
