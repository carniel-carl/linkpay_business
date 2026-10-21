import { PageHeaderSkeleton } from "@/components/common/page-skeleton"
import { FilterBarSkeleton, RowsSkeleton, SummarySkeleton } from "@/components/transactions/skeletons"

export default function Loading() {
  return (
    <div aria-busy aria-label="Loading payment links" className="grid gap-6">
      <PageHeaderSkeleton />
      <SummarySkeleton />
      <div className="surface overflow-hidden">
        <FilterBarSkeleton />
        <div className="border-t">
          <RowsSkeleton />
        </div>
      </div>
    </div>
  )
}
