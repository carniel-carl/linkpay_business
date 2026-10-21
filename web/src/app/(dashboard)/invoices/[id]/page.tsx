import type { Metadata } from "next"
import { notFound, redirect } from "next/navigation"
import { PageHeader } from "@/components/common/page-header"
import { InvoiceActions } from "@/components/invoices/invoice-actions"
import { InvoicePaper } from "@/components/invoices/invoice-paper"
import { InvoicesLocked } from "@/components/invoices/locked"
import { brandingLogoSrc, InvoiceStatusBadge, paperBusiness, toPaper } from "@/components/invoices/parts"
import { PaymentsPanel } from "@/components/invoices/payments-panel"
import type { Invoice } from "@/lib/api/types"
import { getBranding, getInvoice, getOverview } from "@/lib/data"
import { formatDateTime } from "@/lib/format"
import { DEFAULT_ACCENT_PALETTE } from "@/lib/invoices"
import { can } from "@/lib/permissions"

export async function generateMetadata({ params }: PageProps<"/invoices/[id]">): Promise<Metadata> {
  const invoice = await getInvoice((await params).id)
  return { title: invoice ? `${invoice.number}, ${invoice.customer.name}` : "Invoice" }
}

export default async function InvoicePage({ params }: PageProps<"/invoices/[id]">) {
  const { id } = await params
  const overview = await getOverview()
  if (!overview || overview.business.status !== "approved") redirect("/invoices")
  if (!can(overview, "accounts.view")) return <InvoicesLocked />

  const [invoice, branding] = await Promise.all([getInvoice(id), getBranding()])
  if (!invoice) notFound()
  const canManage = can(overview, "invoices.manage")

  return (
    <>
      <PageHeader
        back={{ href: "/invoices", label: "Invoices" }}
        title={
          <span className="flex flex-wrap items-center gap-x-4 gap-y-2">
            {invoice.number}
            {/* Body type inside the display title, so the tag reads like the ones in the list. */}
            <InvoiceStatusBadge invoice={invoice} className="font-sans tracking-normal" />
          </span>
        }
        description={
          <>
            {invoice.customer.name}
            {invoice.branch ? `, paid into ${invoice.branch.name}` : ""}
          </>
        }
        actions={canManage && <InvoiceActions invoice={invoice} />}
      />
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <InvoicePaper
          invoice={toPaper(invoice)}
          business={paperBusiness(overview.business)}
          palette={branding.ok ? branding.data.palette : DEFAULT_ACCENT_PALETTE}
          logoSrc={branding.ok ? brandingLogoSrc(branding.data.logo) : null}
        />
        <div className="grid gap-6 xl:sticky xl:top-24">
          <PaymentsPanel invoice={invoice} canManage={canManage} />
          <Activity invoice={invoice} />
        </div>
      </div>
    </>
  )
}

/** What's happened to the invoice, newest first. Only events the backend recorded. */
function Activity({ invoice }: { invoice: Invoice }) {
  const events: { at: string; text: string }[] = [
    { at: invoice.createdAt, text: `Created${invoice.createdBy ? ` by ${invoice.createdBy.name}` : ""}` },
    ...(invoice.issuedAt ? [{ at: invoice.issuedAt, text: "Marked as sent" }] : []),
    ...(invoice.lastSentAt ? [{ at: invoice.lastSentAt, text: `Emailed to ${invoice.lastSentTo ?? "the customer"}` }] : []),
    ...(invoice.viewedAt ? [{ at: invoice.viewedAt, text: "First opened by the customer" }] : []),
    ...(invoice.reminders.lastSentAt ? [{ at: invoice.reminders.lastSentAt, text: "Latest reminder sent" }] : []),
    ...invoice.payments.map((p) => ({ at: p.paidAt, text: p.auto ? "Payment matched from the narration" : "Payment recorded" })),
    ...(invoice.paidAt ? [{ at: invoice.paidAt, text: "Paid in full" }] : []),
    ...(invoice.receiptSentAt ? [{ at: invoice.receiptSentAt, text: "Receipt emailed" }] : []),
    ...(invoice.voidedAt ? [{ at: invoice.voidedAt, text: "Voided" }] : []),
  ]
  // "Marked as sent" and "Emailed" happen together when it's emailed the first time.
  const shown = events
    .filter((e) => !(e.text === "Marked as sent" && invoice.lastSentAt && Math.abs(Date.parse(e.at) - Date.parse(invoice.lastSentAt)) < 60_000))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))

  return (
    <section aria-labelledby="activity-title" className="surface grid gap-4 p-6">
      <h2 id="activity-title" className="text-sm font-medium">
        Activity
      </h2>
      <ol className="grid gap-3">
        {shown.map((e, i) => (
          <li key={i} className="grid grid-cols-[0.5rem_minmax(0,1fr)] gap-x-3 text-sm">
            <span className={i === 0 ? "mt-1.5 size-2 rounded-full bg-primary" : "mt-1.5 size-2 rounded-full bg-border"} aria-hidden />
            <span className="grid gap-0.5">
              {e.text}
              <span className="text-xs text-muted-foreground">{formatDateTime(e.at)}</span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  )
}
