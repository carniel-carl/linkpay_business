import type { Metadata } from "next"
import Link from "next/link"
import { Palette, Plus, ReceiptText } from "lucide-react"
import { PageHeader } from "@/components/common/page-header"
import { FeaturePlaceholder } from "@/components/dashboard/feature-placeholder"
import { InvoicesLocked } from "@/components/invoices/locked"
import { InvoicesView } from "@/components/invoices/invoices-view"
import { InvoiceSummaryCard } from "@/components/invoices/summary-card"
import { InvoicesUnavailable } from "@/components/invoices/invoices-unavailable"
import { WriteGate } from "@/components/shell/write-gate"
import { Button } from "@/components/ui/button"
import { getInvoices, getInvoiceSummary, getOverview, getSelected } from "@/lib/data"
import { parseInvoiceQuery, toApiParams } from "@/lib/invoices"
import { can } from "@/lib/permissions"

export const metadata: Metadata = { title: "Invoices" }

export default async function InvoicesPage({ searchParams }: PageProps<"/invoices">) {
  const overview = await getOverview()
  if (!overview || overview.business.status !== "approved") {
    return (
      <FeaturePlaceholder
        title="Invoices"
        icon={ReceiptText}
        summary="Bill customers and track what they owe."
        detail="Branded invoices your customers pay straight into your account."
      />
    )
  }
  if (!can(overview, "accounts.view")) return <InvoicesLocked />
  const canManage = can(overview, "invoices.manage")

  const query = parseInvoiceQuery(await searchParams)
  const selected = await getSelected()
  const branches = overview.branches ?? []
  const summaryParams = new URLSearchParams(selected ? { branch: selected._id } : {})

  const [list, summary] = await Promise.all([getInvoices(toApiParams(query, selected?._id)), getInvoiceSummary(summaryParams)])

  // Disabled, with the reason, while the business is suspended.
  const newInvoice = canManage && (
    <WriteGate>
      <Button asChild>
        <Link href="/invoices/new">
          <Plus data-icon="inline-start" aria-hidden />
          New invoice
        </Link>
      </Button>
    </WriteGate>
  )

  return (
    <>
      <PageHeader
        title={selected && branches.length > 1 ? `Invoices, ${selected.name}` : "Invoices"}
        description={
          selected && branches.length > 1
            ? `Showing invoices paid into ${selected.name}.`
            : "Bill customers in your own branding. Payments are matched to invoices as they land."
        }
        actions={
          canManage && (
            <>
              <Button variant="outline" asChild>
                <Link href="/settings/branding">
                  <Palette data-icon="inline-start" aria-hidden />
                  Branding
                </Link>
              </Button>
              {newInvoice}
            </>
          )
        }
      />
      {list.ok ? (
        <div className="grid gap-6">
          <InvoiceSummaryCard summary={summary.ok ? summary.data : null} />
          <InvoicesView data={list.data} query={query} showBranch={!selected && branches.length > 1} newInvoice={newInvoice} />
        </div>
      ) : (
        <InvoicesUnavailable />
      )}
    </>
  )
}
