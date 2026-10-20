import { BandHeaderSkeleton } from "@/components/admin/admin-skeletons"
import { Skeleton } from "@/components/ui/skeleton"

export default function Loading() {
  return (
    <>
      <BandHeaderSkeleton back />
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]" aria-busy aria-label="Loading">
        <div className="grid gap-6">
          <Skeleton className="h-44 rounded-2xl" />
          <Skeleton className="h-72 rounded-2xl" />
          <Skeleton className="h-48 rounded-2xl" />
        </div>
        <Skeleton className="h-[70vh] rounded-2xl" />
      </div>
    </>
  )
}
