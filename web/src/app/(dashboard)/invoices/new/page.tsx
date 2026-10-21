import type { Metadata } from "next"
import { redirect } from "next/navigation"
import { PageHeader } from "@/components/common/page-header"
import { EditorPage } from "@/components/invoices/editor-page"
import { InvoicesLocked } from "@/components/invoices/locked"
import { getOverview } from "@/lib/data"
import { can } from "@/lib/permissions"

export const metadata: Metadata = { title: "New invoice" }

export default async function NewInvoicePage() {
  const overview = await getOverview()
  if (!overview || overview.business.status !== "approved") redirect("/invoices")
  if (!can(overview, "invoices.manage")) return <InvoicesLocked action />
  return (
    <>
      <PageHeader
        back={{ href: "/invoices", label: "Invoices" }}
        title="New invoice"
        description="Save it as a draft, check it over, then send it or share the link."
      />
      <EditorPage overview={overview} />
    </>
  )
}
