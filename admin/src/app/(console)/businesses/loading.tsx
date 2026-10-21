import { BandHeaderSkeleton, BusinessesTableSkeleton } from "@/components/admin/admin-skeletons"

export default function Loading() {
  return (
    <>
      <BandHeaderSkeleton />
      <BusinessesTableSkeleton tabs />
    </>
  )
}
