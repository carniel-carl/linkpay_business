import type { Metadata } from "next"
import { notFound, redirect } from "next/navigation"
import { PageHeader } from "@/components/common/page-header"
import { EditorPage } from "@/components/invoices/editor-page"
import { InvoicesLocked } from "@/components/invoices/locked"
import { getInvoice, getOverview } from "@/lib/data"
import { can } from "@/lib/permissions"

export const metadata: Metadata = { title: "Edit invoice" }

export default async function EditInvoicePage({ params }: PageProps<"/invoices/[id]/edit">) {
  const { id } = await params
  const overview = await getOverview()
  if (!overview || overview.business.status !== "approved") redirect("/invoices")
  if (!can(overview, "invoices.manage")) return <InvoicesLocked action />
  const invoice = await getInvoice(id)
  if (!invoice) notFound()
  // Paid and void invoices are a record; nothing on them changes.
  if (invoice.status === "paid" || invoice.status === "void") redirect(`/invoices/${invoice._id}`)
  return (
    <>
      <PageHeader
        back={{ href: `/invoices/${invoice._id}`, label: invoice.number }}
        title={`Edit ${invoice.number}`}
        description={invoice.status === "draft" ? "Still a draft, so your customer hasn't seen it." : "Your customer sees the changes the next time they open the link."}
      />
      <EditorPage overview={overview} invoice={invoice} />
    </>
  )
}
