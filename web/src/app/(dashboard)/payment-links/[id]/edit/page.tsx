import type { Metadata } from "next"
import { notFound, redirect } from "next/navigation"
import { PageHeader } from "@/components/common/page-header"
import { EditorPage } from "@/components/payment-links/editor-page"
import { PaymentLinksLocked } from "@/components/payment-links/parts"
import { getOverview, getPaymentLink } from "@/lib/data"
import { can } from "@/lib/permissions"

export const metadata: Metadata = { title: "Edit payment link" }

export default async function EditPaymentLinkPage({ params }: PageProps<"/payment-links/[id]/edit">) {
  const { id } = await params
  const overview = await getOverview()
  if (!overview || overview.business.status !== "approved") redirect("/payment-links")
  if (!can(overview, "accounts.view")) return <PaymentLinksLocked />
  const link = await getPaymentLink(id)
  if (!link) notFound()
  if (!link.canManage) redirect(`/payment-links/${link._id}`)
  return (
    <>
      <PageHeader
        back={{ href: `/payment-links/${link._id}`, label: link.title }}
        title="Edit payment link"
        description="Changes apply to new payments. Anyone already paying keeps the amount they were given."
      />
      <EditorPage overview={overview} link={link} />
    </>
  )
}
