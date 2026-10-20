import type { Metadata } from "next"
import { PageHeader } from "@/components/common/page-header"
import { requireEditableOverview } from "@/lib/guards"
import { DetailsForm } from "./details-form"

export const metadata: Metadata = { title: "Business details" }

export default async function DetailsPage() {
  const { business } = await requireEditableOverview()
  return (
    <>
      <PageHeader
        title="Business details"
        description="We check these against your CAC and FIRS records. Changes save as you go."
      />
      <DetailsForm
        defaults={{
          name: business.name,
          registrationNumber: business.registrationNumber ?? "",
          tin: business.tin ?? "",
          industry: business.industry ?? "",
          description: business.description ?? "",
          email: business.email ?? "",
          phone: business.phone ?? "",
          website: business.website ?? "",
          address: {
            street: business.address?.street ?? "",
            city: business.address?.city ?? "",
            state: business.address?.state ?? "",
          },
        }}
      />
    </>
  )
}
