import type { Metadata } from "next"
import { redirect } from "next/navigation"
import { BrandingForm } from "@/components/invoices/branding-form"
import { InvoicesUnavailable } from "@/components/invoices/invoices-unavailable"
import { paperBusiness, payToFor } from "@/components/invoices/parts"
import { getBranding, getOverview, getSelected } from "@/lib/data"
import { can } from "@/lib/permissions"

export const metadata: Metadata = { title: "Invoice branding" }

export default async function BrandingPage() {
  const overview = await getOverview()
  if (!overview || overview.business.status !== "approved" || !can(overview, "invoices.manage")) redirect("/settings")
  const [branding, selected] = await Promise.all([getBranding(), getSelected()])
  if (!branding.ok) return <InvoicesUnavailable />
  const branches = overview.branches ?? []
  const branch = branches.find((b) => b._id === selected?._id) ?? branches.find((b) => b.isHeadOffice)
  return <BrandingForm branding={branding.data} business={paperBusiness(overview.business)} payTo={payToFor(branch)} />
}
