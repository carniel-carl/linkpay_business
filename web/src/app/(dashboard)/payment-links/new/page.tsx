import type { Metadata } from "next"
import { redirect } from "next/navigation"
import { PageHeader } from "@/components/common/page-header"
import { EditorPage } from "@/components/payment-links/editor-page"
import { PaymentLinksLocked } from "@/components/payment-links/parts"
import { getOverview } from "@/lib/data"
import { can } from "@/lib/permissions"

export const metadata: Metadata = { title: "New payment link" }

export default async function NewPaymentLinkPage() {
  const overview = await getOverview()
  if (!overview || overview.business.status !== "approved") redirect("/payment-links")
  if (!can(overview, "accounts.view")) return <PaymentLinksLocked />
  // Only members who can manage payments make links, and only into a branch with an open account.
  if (!can(overview, "payments.manage") || !(overview.branches ?? []).some((b) => b.account)) redirect("/payment-links")
  return (
    <>
      <PageHeader
        back={{ href: "/payment-links", label: "Payment links" }}
        title="New payment link"
        description="Customers pay by bank transfer into the branch's account. Each one gets an exact amount to send, so we can match their payment."
      />
      <EditorPage overview={overview} />
    </>
  )
}
