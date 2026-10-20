import { FormSkeleton, PageHeaderSkeleton } from "@/components/common/page-skeleton"

export default function Loading() {
  return (
    <>
      <PageHeaderSkeleton />
      <FormSkeleton />
    </>
  )
}
