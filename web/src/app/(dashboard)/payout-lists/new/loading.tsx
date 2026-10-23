import { FormSkeleton, PageHeaderSkeleton } from "@/components/common/page-skeleton"

export default function Loading() {
  return (
    <div aria-busy aria-label="Loading" className="grid gap-6">
      <PageHeaderSkeleton />
      <div className="surface p-5 sm:p-7">
        <FormSkeleton fields={2} />
      </div>
    </div>
  )
}
