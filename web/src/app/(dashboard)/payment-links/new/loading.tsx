import { PageHeaderSkeleton } from "@/components/common/page-skeleton"
import { Skeleton } from "@/components/ui/skeleton"

export default function Loading() {
  return (
    <div aria-busy aria-label="Loading the payment link form" className="grid gap-6">
      <PageHeaderSkeleton />
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,28rem)] 2xl:grid-cols-[minmax(0,1fr)_minmax(0,32rem)]">
        <div className="grid gap-6">
          <Skeleton className="h-96 rounded-[18px]" />
          <Skeleton className="h-48 rounded-[18px]" />
        </div>
        <Skeleton className="hidden h-[36rem] rounded-[18px] xl:block" />
      </div>
    </div>
  )
}
