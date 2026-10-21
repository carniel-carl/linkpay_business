import type { BrandPalette, Invoice, InvoiceCustomerDetails, InvoiceItem, PayTo } from "@/lib/api/types"
import { formatNaira } from "@/lib/format"
import { bpsToPercent, describeDiscount, formatDay, narrationHint } from "@/lib/invoices"
import { cn } from "@/lib/utils"

/** What the paper shows. Built from an invoice, the editor's draft or the public invoice. */
export type PaperInvoice = {
  number: string
  status: Invoice["status"]
  overdue: boolean
  customer: Pick<InvoiceCustomerDetails, "name" | "email" | "phone" | "address">
  issueDate: string
  dueDate: string
  items: InvoiceItem[]
  subtotalKobo: number
  /** Set when the discount is a percentage, for the "Discount (10%)" label. */
  discountPercentBps: number | null
  discountKobo: number
  vatRateBps: number | null
  vatKobo: number
  totalKobo: number
  paidKobo: number
  balanceKobo: number
  notes: string | null
  terms: string | null
  footer: string | null
  payTo: PayTo | null
}

export type PaperBusiness = { name: string; email?: string | null; phone?: string | null; address?: string | null }

type Props = {
  invoice: PaperInvoice
  business: PaperBusiness
  palette: BrandPalette
  /** The business's logo; without one its name is set in the accent colour. */
  logoSrc?: string | null
  className?: string
}

/**
 * The business's invoice as its customer sees it: white paper in the business's accent colour, laid out
 * like the PDF. Used by the editor preview, the invoice page and the public link.
 */
export function InvoicePaper({ invoice, business, palette, logoSrc, className }: Props) {
  const paid = invoice.status === "paid"
  const isVoid = invoice.status === "void"
  const showPayTo = !paid && !isVoid && invoice.payTo
  const brand = {
    "--accent": palette.accent,
    "--on-accent": palette.onAccent,
    "--accent-text": palette.accentText,
  } as React.CSSProperties

  return (
    <article
      style={brand}
      aria-label={`Invoice ${invoice.number} from ${business.name}`}
      className={cn("relative overflow-hidden rounded-xl bg-paper text-[13px] leading-normal text-paper-ink shadow-surface", className)}
    >
      <div className="h-1.5 bg-(--accent)" aria-hidden />
      <div className="grid gap-8 p-6 sm:p-10">
        <header className="flex flex-wrap items-start justify-between gap-6">
          <div className="grid max-w-[60%] gap-3">
            {logoSrc ? (
              // eslint-disable-next-line @next/next/no-img-element -- a proxied, per-business upload
              <img src={logoSrc} alt={business.name} className="max-h-14 w-auto max-w-48 object-contain object-left" />
            ) : (
              <p className="text-xl font-semibold tracking-tight text-(--accent-text)">{business.name}</p>
            )}
            <div className="grid gap-0.5 text-paper-muted">
              {logoSrc && <p className="font-medium text-paper-ink">{business.name}</p>}
              {business.address && <p className="whitespace-pre-line">{business.address}</p>}
              {[business.email, business.phone].filter(Boolean).length > 0 && (
                <p>{[business.email, business.phone].filter(Boolean).join(" · ")}</p>
              )}
            </div>
          </div>
          <div className="grid justify-items-end gap-1 text-right">
            <p className="text-xs font-semibold tracking-[0.18em] text-(--accent-text) uppercase">Invoice</p>
            <p className="text-lg font-semibold figure">{invoice.number || "Draft"}</p>
            <Stamp status={invoice.status} overdue={invoice.overdue} />
          </div>
        </header>

        <section className="grid gap-6 sm:grid-cols-[1fr_auto]">
          <div className="grid content-start gap-1">
            <p className="text-xs font-medium tracking-wide text-paper-muted uppercase">Bill to</p>
            <p className="font-medium">{invoice.customer.name || "Customer name"}</p>
            {invoice.customer.address && <p className="whitespace-pre-line text-paper-muted">{invoice.customer.address}</p>}
            {[invoice.customer.email, invoice.customer.phone].filter(Boolean).length > 0 && (
              <p className="text-paper-muted">{[invoice.customer.email, invoice.customer.phone].filter(Boolean).join(" · ")}</p>
            )}
          </div>
          <dl className="grid grid-cols-[auto_auto] content-start gap-x-6 gap-y-1">
            <dt className="text-paper-muted">Issued</dt>
            <dd className="text-right figure">{formatDay(invoice.issueDate)}</dd>
            <dt className="text-paper-muted">Due</dt>
            <dd className="text-right font-medium figure">{formatDay(invoice.dueDate)}</dd>
          </dl>
        </section>

        <section>
          <table className="w-full border-collapse">
            <caption className="sr-only">Items</caption>
            <thead>
              <tr className="border-b-2 border-(--accent) text-left text-xs text-paper-muted">
                <th scope="col" className="py-2 pr-3 font-medium">Description</th>
                <th scope="col" className="hidden py-2 pr-3 text-right font-medium sm:table-cell">Qty</th>
                <th scope="col" className="hidden py-2 pr-3 text-right font-medium sm:table-cell">Price</th>
                <th scope="col" className="py-2 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody>
              {invoice.items.length === 0 ? (
                <tr className="border-b border-paper-rule">
                  <td colSpan={4} className="py-4 text-paper-muted">Add an item to see it here.</td>
                </tr>
              ) : (
                invoice.items.map((item, i) => (
                  <tr key={i} className="border-b border-paper-rule align-top">
                    <td className="py-3 pr-3">
                      <span className="whitespace-pre-line">{item.description || "Item"}</span>
                      <span className="mt-0.5 block text-xs text-paper-muted figure sm:hidden">
                        {item.quantity} × {formatNaira(item.unitPriceKobo)}
                      </span>
                    </td>
                    <td className="hidden py-3 pr-3 text-right figure sm:table-cell">{item.quantity}</td>
                    <td className="hidden py-3 pr-3 text-right figure sm:table-cell">{formatNaira(item.unitPriceKobo)}</td>
                    <td className="py-3 text-right figure">{formatNaira(item.amountKobo)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>

          <dl className="mt-4 ml-auto grid max-w-72 grid-cols-[1fr_auto] gap-x-6 gap-y-1.5">
            <dt className="text-paper-muted">Subtotal</dt>
            <dd className="text-right figure">{formatNaira(invoice.subtotalKobo)}</dd>
            {invoice.discountKobo > 0 && (
              <>
                <dt className="text-paper-muted">{describeDiscount(invoice.discountPercentBps)}</dt>
                <dd className="text-right figure">−{formatNaira(invoice.discountKobo)}</dd>
              </>
            )}
            {invoice.vatRateBps !== null && (
              <>
                <dt className="text-paper-muted">VAT ({bpsToPercent(invoice.vatRateBps)}%)</dt>
                <dd className="text-right figure">{formatNaira(invoice.vatKobo)}</dd>
              </>
            )}
            <dt className="border-t border-paper-rule pt-2 font-medium">Total</dt>
            <dd className="border-t border-paper-rule pt-2 text-right font-medium figure">{formatNaira(invoice.totalKobo)}</dd>
            {invoice.paidKobo > 0 && (
              <>
                <dt className="text-paper-muted">Paid</dt>
                <dd className="text-right figure">−{formatNaira(invoice.paidKobo)}</dd>
              </>
            )}
          </dl>
          {!isVoid && (
            <div className="mt-3 ml-auto flex max-w-72 items-baseline justify-between gap-6 rounded-lg bg-(--accent) px-4 py-3 text-(--on-accent)">
              <span className="font-medium">{paid ? "Paid in full" : "Balance due"}</span>
              <span className="text-lg font-semibold figure">{formatNaira(paid ? invoice.totalKobo : invoice.balanceKobo)}</span>
            </div>
          )}
        </section>

        {showPayTo && (
          <section className="grid gap-3 rounded-lg bg-paper-tint p-4 sm:p-5">
            <p className="text-xs font-medium tracking-wide text-paper-muted uppercase">How to pay</p>
            <dl className="grid gap-x-8 gap-y-2 sm:grid-cols-3">
              <div className="grid gap-0.5">
                <dt className="text-xs text-paper-muted">Bank</dt>
                <dd className="font-medium">{invoice.payTo!.bankName ?? "Not shown"}</dd>
              </div>
              <div className="grid gap-0.5">
                <dt className="text-xs text-paper-muted">Account number</dt>
                <dd className="font-mono text-base font-medium tracking-wide">{invoice.payTo!.accountNumber}</dd>
              </div>
              <div className="grid gap-0.5">
                <dt className="text-xs text-paper-muted">Account name</dt>
                <dd className="font-medium">{invoice.payTo!.accountName ?? business.name}</dd>
              </div>
            </dl>
            <p className="text-paper-muted">{narrationHint(invoice.number)}</p>
          </section>
        )}

        {(invoice.notes || invoice.terms) && (
          <section className="grid gap-5 sm:grid-cols-2">
            {invoice.notes && (
              <div className="grid content-start gap-1">
                <p className="text-xs font-medium tracking-wide text-paper-muted uppercase">Notes</p>
                <p className="whitespace-pre-line">{invoice.notes}</p>
              </div>
            )}
            {invoice.terms && (
              <div className="grid content-start gap-1">
                <p className="text-xs font-medium tracking-wide text-paper-muted uppercase">Terms</p>
                <p className="whitespace-pre-line">{invoice.terms}</p>
              </div>
            )}
          </section>
        )}

        {invoice.footer && <footer className="border-t border-paper-rule pt-4 text-center text-xs whitespace-pre-line text-paper-muted">{invoice.footer}</footer>}
      </div>
    </article>
  )
}

/** Paid and void are stamped on the paper; drafts say so, so a screenshot of one can't pass as issued. */
function Stamp({ status, overdue }: { status: Invoice["status"]; overdue: boolean }) {
  const label = status === "paid" ? "Paid" : status === "void" ? "Void" : status === "draft" ? "Draft" : overdue ? "Overdue" : null
  if (!label) return null
  return (
    <span
      className={cn(
        "mt-1 rounded-md border-2 px-2 py-0.5 text-xs font-semibold tracking-[0.14em] uppercase",
        status === "paid" ? "border-(--accent) text-(--accent-text)" : "border-paper-rule text-paper-muted",
      )}
    >
      {label}
    </span>
  )
}
