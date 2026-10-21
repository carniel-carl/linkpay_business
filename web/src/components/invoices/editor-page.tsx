import "server-only"
import { InvoicesUnavailable } from "@/components/invoices/invoices-unavailable"
import type { Invoice, Overview } from "@/lib/api/types"
import { getBranding, getInvoiceCustomers, getInvoiceDefaults, getSelected } from "@/lib/data"
import { InvoiceEditor } from "./invoice-editor"
import { brandingLogoSrc, paperBusiness } from "./parts"

/** Loads what the editor needs: branding for the preview, saved customers, the member's branches. */
export async function EditorPage({ overview, invoice }: { overview: Overview; invoice?: Invoice }) {
  const [branding, customers, defaults, selected] = await Promise.all([
    getBranding(),
    getInvoiceCustomers(),
    invoice ? null : getInvoiceDefaults(),
    getSelected(),
  ])
  if (!branding.ok) return <InvoicesUnavailable />
  return (
    <InvoiceEditor
      branches={overview.branches ?? []}
      customers={customers.ok ? customers.data.items : []}
      branding={branding.data}
      defaults={defaults?.ok ? defaults.data : null}
      business={paperBusiness(overview.business)}
      logoSrc={brandingLogoSrc(branding.data.logo)}
      defaultBranchId={selected?._id}
      invoice={invoice}
    />
  )
}
