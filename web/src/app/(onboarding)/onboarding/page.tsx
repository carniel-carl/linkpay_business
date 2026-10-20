import type { Metadata } from "next"
import { redirect } from "next/navigation"
import { PageHeader } from "@/components/common/page-header"
import { getOverview } from "@/lib/data"
import { EDITABLE } from "@/lib/onboarding"
import { BusinessTypeForm } from "./business-type-form"

export const metadata: Metadata = { title: "Set up your business" }

export default async function BusinessTypePage() {
  const overview = await getOverview()
  if (overview?.business.status === "approved") redirect("/dashboard")
  if (overview && !EDITABLE.includes(overview.business.status)) redirect("/onboarding/status")

  return (
    <>
      <PageHeader
        title={overview ? "Business type" : "Let's set up your business"}
        description="Tell us how your business is registered with the Corporate Affairs Commission. This decides which documents we'll ask for."
      />
      <BusinessTypeForm business={overview ? { name: overview.business.name, type: overview.business.type } : undefined} />
    </>
  )
}
