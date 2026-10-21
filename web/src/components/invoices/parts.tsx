import { Badge } from "@/components/ui/badge"
import type { Branch, Business, Invoice, InvoiceListItem, InvoiceStatus, PayTo } from "@/lib/api/types"
import { discountPercentBps, statusLabel } from "@/lib/invoices"
import type { PaperBusiness, PaperInvoice } from "./invoice-paper"

const STATUS_VARIANT: Record<InvoiceStatus, React.ComponentProps<typeof Badge>["variant"]> = {
  draft: "muted",
  open: "secondary",
  partially_paid: "warning",
  paid: "success",
  void: "muted",
}

export function InvoiceStatusBadge({ invoice, className }: { invoice: Pick<InvoiceListItem, "status" | "overdue">; className?: string }) {
  return (
    <Badge variant={invoice.overdue ? "destructive" : (STATUS_VARIANT[invoice.status] ?? "muted")} className={className}>
      {statusLabel(invoice)}
    </Badge>
  )
}

/** Where the logo comes from on signed-in pages (the file proxy), with the version so a new logo shows straight away. */
export function brandingLogoSrc(logo: { url: string } | null | undefined) {
  if (!logo) return null
  const version = new URL(logo.url, "http://x").searchParams.get("v")
  return `/api/files/branding${version ? `?v=${encodeURIComponent(version)}` : ""}`
}

/** The business as it appears at the top of its invoices. */
export function paperBusiness(business: Pick<Business, "name" | "email" | "phone" | "address">): PaperBusiness {
  const a = business.address
  const cityLine = [a?.city, a?.state].filter(Boolean).join(", ")
  return {
    name: business.name,
    email: business.email ?? null,
    phone: business.phone ?? null,
    address: [a?.street, cityLine].filter(Boolean).join("\n") || null,
  }
}

/** The branch's account as the invoice shows it, or null while it's still being set up. */
export function payToFor(branch: Pick<Branch, "account"> | undefined): PayTo | null {
  return branch?.account
    ? { accountNumber: branch.account.accountNumber, accountName: branch.account.accountName ?? null, bankName: branch.account.bankName ?? null }
    : null
}

export const toPaper = (invoice: Invoice): PaperInvoice => ({ ...invoice, discountPercentBps: discountPercentBps(invoice.discount) })
