import { PageHeaderSkeleton } from "@/components/common/page-skeleton"
import { FilterBarSkeleton, RowsSkeleton, SummarySkeleton } from "@/components/transactions/skeletons"

// First visit. The first load in a while can take a few seconds while the backend fetches new payments
// from the bank; filter changes after that show the same skeletons from inside the view.
export default function Loading() {
  return (
    <div aria-busy aria-label="Loading transactions" className="grid gap-6">
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
