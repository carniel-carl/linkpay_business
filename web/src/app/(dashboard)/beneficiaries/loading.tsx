import { PageHeaderSkeleton } from "@/components/common/page-skeleton"
import { RowsSkeleton } from "@/components/transactions/skeletons"
import { Skeleton } from "@/components/ui/skeleton"

export default function Loading() {
  return (
    <div aria-busy aria-label="Loading beneficiaries" className="grid gap-6">
      <PageHeaderSkeleton />
      <div className="surface overflow-hidden">
        <div className="px-4 py-3 sm:px-6" aria-hidden>
          <Skeleton className="h-8 w-full sm:w-96" />
        </div>
        <div className="border-t">
          <RowsSkeleton showBranch={false} />
        </div>
      </div>
    </div>
  )
}
