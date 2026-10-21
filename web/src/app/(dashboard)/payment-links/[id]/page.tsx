import type { Metadata } from "next"
import { notFound, redirect } from "next/navigation"
import { PageHeader } from "@/components/common/page-header"
import { CheckoutsView } from "@/components/payment-links/checkouts-view"
import { EmbedCard, ShareCard } from "@/components/payment-links/embed-card"
import { LinkActions } from "@/components/payment-links/link-actions"
import { LinkStateBadge, OriginsList, PaymentLinksLocked } from "@/components/payment-links/parts"
import { TransactionsUnavailable } from "@/components/transactions/transactions-unavailable"
import type { PaymentLink } from "@/lib/api/types"
import { brandingLogoSrc } from "@/components/invoices/parts"
import { getBranding, getLinkCheckout, getLinkCheckouts, getOverview, getPaymentLink, getPaymentLinkEmbed } from "@/lib/data"
import { formatDate, formatDateTime, formatNaira } from "@/lib/format"
import { checkoutsApiParams, FALLBACK_PALETTE, linkImageSrc, parseCheckoutQuery, paymentsLabel, PHONE_LABELS, priceLabel, UNAVAILABLE_LABELS } from "@/lib/payment-links"
import { can } from "@/lib/permissions"

export async function generateMetadata({ params }: PageProps<"/payment-links/[id]">): Promise<Metadata> {
  const link = await getPaymentLink((await params).id)
  return { title: link ? link.title : "Payment link" }
}

export default async function PaymentLinkPage({ params, searchParams }: PageProps<"/payment-links/[id]">) {
  const { id } = await params
  const overview = await getOverview()
  if (!overview || overview.business.status !== "approved") redirect("/payment-links")
  if (!can(overview, "accounts.view")) return <PaymentLinksLocked />

  const query = parseCheckoutQuery(await searchParams)
  const [link, embed, checkouts, linked, branding] = await Promise.all([
    getPaymentLink(id),
    getPaymentLinkEmbed(id),
    getLinkCheckouts(checkoutsApiParams(query, { link: id })),
    query.checkout ? getLinkCheckout(query.checkout) : null,
    getBranding(),
  ])
  if (!link) notFound()
  // For the QR code: the business as its payers see it.
  const brand = {
    name: overview.business.name,
    logoSrc: branding.ok ? brandingLogoSrc(branding.data.logo) : null,
    palette: branding.ok ? branding.data.palette : FALLBACK_PALETTE,
  }
  const canManage = link.canManage

  return (
    <>
      <PageHeader
        back={{ href: "/payment-links", label: "Payment links" }}
        title={
          <span className="flex flex-wrap items-center gap-x-4 gap-y-2">
            {link.title}
            <LinkStateBadge link={link} className="font-sans tracking-normal" />
          </span>
        }
        description={
          <>
            <span className="figure">{priceLabel(link)}</span>
            {link.branch ? `, paid into ${link.branch.name}` : ""}
          </>
        }
        actions={canManage && <LinkActions link={link} />}
      />
      <div className="grid min-w-0 grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="grid min-w-0 gap-6">
          <Totals link={link} />
          {checkouts.ok ? (
            <CheckoutsView
              data={checkouts.data}
              query={{ tab: query.status, q: query.q, page: query.page, size: query.size, checkout: query.checkout }}
              tabParam="status"
              showLink={false}
              showBranch={false}
              linked={linked?.ok && linked.data.link?._id === link._id ? linked.data : null}
            />
          ) : (
            <TransactionsUnavailable />
          )}
        </div>
        <div className="grid min-w-0 gap-6 xl:sticky xl:top-24">
          <ShareCard link={link} brand={brand} />
          <EmbedCard embed={embed.ok ? embed.data : null} />
          <Settings link={link} />
        </div>
      </div>
    </>
  )
}

function Totals({ link }: { link: PaymentLink }) {
  return (
    <section aria-label="Totals" className="surface grid gap-6 p-6 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end sm:p-8">
      <div className="grid gap-1.5">
        <p className="text-sm text-muted-foreground">Collected</p>
        <p className="type-display text-[2.5rem] break-all sm:text-5xl figure">{formatNaira(link.collectedKobo)}</p>
        <p className="text-sm text-muted-foreground">
          {paymentsLabel(link)}
          {link.lastPaidAt ? `, the latest ${formatDateTime(link.lastPaidAt)}` : ""}
        </p>
      </div>
      {!link.available && link.unavailableReason && (
        <p className="max-w-64 text-sm text-muted-foreground sm:text-right">
          {link.unavailableReason === "inactive"
            ? "Turned off. The page says it isn't taking payments."
            : link.unavailableReason === "expired"
              ? `Ended ${formatDate(link.expiresAt ?? undefined)}. Edit the end date to take payments again.`
              : link.unavailableReason === "sold_out"
                ? "The payment limit is reached. Raise it to take more."
                : UNAVAILABLE_LABELS.account_not_ready}
        </p>
      )}
    </section>
  )
}

/** What the page asks for and its limits, as saved. */
function Settings({ link }: { link: PaymentLink }) {
  const rows: [string, React.ReactNode][] = [
    ["Amount", <span key="a" className="figure">{link.amountKobo ? formatNaira(link.amountKobo) : priceLabel(link)}</span>],
    ["Phone number", PHONE_LABELS[link.phone]],
    [
      "Questions",
      link.customFields.length ? (
        <ul key="q" className="grid gap-0.5">
          {link.customFields.map((f) => (
            <li key={f._id}>
              {f.label}
              {f.required ? "" : <span className="text-muted-foreground"> (optional)</span>}
            </li>
          ))}
        </ul>
      ) : (
        <span key="q" className="text-muted-foreground">
          None
        </span>
      ),
    ],
    ["Ends", link.expiresAt ? formatDate(link.expiresAt) : <span key="e" className="text-muted-foreground">No end date</span>],
    ["Limit", link.maxPayments ? `${link.maxPayments} payments` : <span key="l" className="text-muted-foreground">No limit</span>],
    ["Thank-you message", link.successMessage ?? <span key="m" className="text-muted-foreground">None</span>],
    ["Then sends them to", link.redirectUrl ? <span key="r" className="break-all">{link.redirectUrl}</span> : <span key="r" className="text-muted-foreground">Nowhere</span>],
    ["Websites", <OriginsList key="w" origins={link.allowedOrigins} />],
  ]
  return (
    <section aria-labelledby="settings-title" className="surface grid min-w-0 gap-4 p-6 [&>*]:min-w-0">
      <h2 id="settings-title" className="text-sm font-medium">
        Settings
      </h2>
      {link.images.length > 0 && (
        <ul aria-label="Pictures" className="grid grid-cols-4 gap-2">
          {link.images.map((img, i) => (
            <li key={img._id}>
              {/* eslint-disable-next-line @next/next/no-img-element -- proxied upload */}
              <img
                src={linkImageSrc(img)}
                alt={i === 0 ? "Cover picture" : `Picture ${i + 1}`}
                className="aspect-square w-full rounded-[10px] bg-muted object-cover"
              />
            </li>
          ))}
        </ul>
      )}
      {link.description && <p className="text-sm whitespace-pre-line text-muted-foreground">{link.description}</p>}
      <dl className="grid gap-3 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="grid grid-cols-[8.5rem_minmax(0,1fr)] gap-3">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="border-t pt-4 text-xs text-muted-foreground">
        Made {formatDate(link.createdAt)}
        {link.createdBy ? ` by ${link.createdBy.name}` : ""}.
      </p>
    </section>
  )
}
