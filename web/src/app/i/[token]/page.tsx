import { cache } from "react"
import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { Download } from "lucide-react"
import { CopyButton } from "@/components/accounts/copy-button"
import { InvoicePaper, type PaperInvoice } from "@/components/invoices/invoice-paper"
import { Button } from "@/components/ui/button"
import { api } from "@/lib/api/client"
import { ApiError } from "@/lib/api/errors"
import type { PublicInvoice } from "@/lib/api/types"
import { formatDate, formatNaira } from "@/lib/format"
import { dueLabel, formatDay } from "@/lib/invoices"
import { cn } from "@/lib/utils"

// The customer's copy of an invoice. No sign-in: the unguessable token in the link is the key, and the
// backend never returns drafts. Always fresh, since payments change it.
export const dynamic = "force-dynamic"

const getPublicInvoice = cache(async (token: string) => {
  try {
    return await api<PublicInvoice>(`/api/public/invoices/${encodeURIComponent(token)}`, { auth: false })
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 400)) return null
    throw err
  }
})

export async function generateMetadata({ params }: PageProps<"/i/[token]">): Promise<Metadata> {
  const data = await getPublicInvoice((await params).token)
  return {
    title: { absolute: data ? `Invoice ${data.invoice.number} from ${data.business.name}` : "Invoice" },
    robots: { index: false, follow: false },
    referrer: "no-referrer",
  }
}

export default async function PublicInvoicePage({ params }: PageProps<"/i/[token]">) {
  const { token } = await params
  const data = await getPublicInvoice(token)
  if (!data) notFound()
  const { business, invoice, payTo } = data

  const version = business.logo ? new URL(business.logo.url, "http://x").searchParams.get("v") : null
  const logoSrc = business.logo ? `/i/${encodeURIComponent(token)}/logo${version ? `?v=${encodeURIComponent(version)}` : ""}` : null
  const paper: PaperInvoice = { ...invoice, payTo, discountPercentBps: invoice.discountPercentBps }
  const paid = invoice.status === "paid"
  const isVoid = invoice.status === "void"
  const pdf = `/i/${encodeURIComponent(token)}/pdf`

  return (
    <main className="min-h-dvh bg-muted/50 px-4 py-8 sm:py-14">
      <div className="mx-auto grid max-w-3xl gap-6">
        <section aria-label="Summary" className="surface grid gap-5 p-6 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end sm:p-8">
          <div className="grid gap-1.5">
            <p className="text-sm text-muted-foreground">
              {business.name}, invoice <span className="figure">{invoice.number}</span>
            </p>
            {isVoid ? (
              <>
                <p className="type-display text-3xl">This invoice was cancelled</p>
                <p className="text-sm text-muted-foreground">There&apos;s nothing to pay. Contact {business.name} if you have questions.</p>
              </>
            ) : paid ? (
              <>
                <p className="type-display text-4xl figure">{formatNaira(invoice.totalKobo)}</p>
                <p className="text-sm text-success-foreground">Paid in full{invoice.paidAt ? ` on ${formatDate(invoice.paidAt)}` : ""}. Thank you.</p>
              </>
            ) : (
              <>
                <p className="type-display text-4xl figure">{formatNaira(invoice.balanceKobo)}</p>
                <p className={cn("text-sm", invoice.overdue ? "text-destructive" : "text-muted-foreground")}>
                  {invoice.paidKobo > 0 && <span className="figure">{formatNaira(invoice.paidKobo)} paid so far. </span>}
                  {dueLabel(invoice.dueDate)}, {formatDay(invoice.dueDate)}
                </p>
              </>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {paid && data.receiptAvailable && (
              <Button asChild>
                <a href={`${pdf}?receipt&download`} download>
                  <Download data-icon="inline-start" aria-hidden />
                  Receipt
                </a>
              </Button>
            )}
            <Button variant={paid ? "outline" : "default"} asChild>
              <a href={`${pdf}?download`} download>
                <Download data-icon="inline-start" aria-hidden />
                Invoice PDF
              </a>
            </Button>
          </div>
        </section>

        {payTo && !isVoid && !paid && (
          <section aria-labelledby="pay-title" className="surface grid gap-4 p-6 sm:p-8">
            <h2 id="pay-title" className="type-display text-xl">
              Pay by bank transfer
            </h2>
            <dl className="grid gap-4 sm:grid-cols-3">
              <div className="grid gap-0.5">
                <dt className="text-xs text-muted-foreground">Account number</dt>
                <dd className="flex items-center gap-1">
                  <span className="font-mono text-xl font-medium tracking-[0.06em]">{payTo.accountNumber}</span>
                  <CopyButton value={payTo.accountNumber} message="Account number copied" label="Copy account number" />
                </dd>
              </div>
              <div className="grid gap-0.5">
                <dt className="text-xs text-muted-foreground">Bank</dt>
                <dd className="font-medium">{payTo.bankName ?? "Not shown"}</dd>
              </div>
              <div className="grid gap-0.5">
                <dt className="text-xs text-muted-foreground">Account name</dt>
                <dd className="font-medium">{payTo.accountName ?? business.name}</dd>
              </div>
            </dl>
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
              Put <span className="font-medium text-foreground figure">{invoice.number}</span> in the narration so your payment is matched to this invoice.
              <CopyButton value={invoice.number} message="Invoice number copied" label="Copy invoice number" />
            </p>
          </section>
        )}

        <InvoicePaper invoice={paper} business={business} palette={business.palette} logoSrc={logoSrc} />

        <p className="text-center text-xs text-muted-foreground">
          Sent by {business.name} with LinkPay Business. Questions about this invoice go to {business.email ?? business.name}.
        </p>
      </div>
    </main>
  )
}
