import type { Metadata } from "next"
import { notFound, redirect } from "next/navigation"
import { PageHeader } from "@/components/common/page-header"
import { CheckoutsView } from "@/components/payment-links/checkouts-view"
import { DonorsPanel } from "@/components/payment-links/donors-panel"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { EmbedCard, ShareCard } from "@/components/payment-links/embed-card"
import { LinkActions, TestModeBanner } from "@/components/payment-links/link-actions"
import { KindBadge, LinkStateBadge, OriginsList, PaymentLinksLocked, TestBadge } from "@/components/payment-links/parts"
import { ShieldAlert } from "lucide-react"
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
  // A fundraiser's donors, first page (the panel loads more as it scrolls).
  const donors = link.kind === "donation" ? await getLinkCheckouts(new URLSearchParams({ link: id, status: "received", take: "50" })) : null
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
            <TestBadge mode={link.mode} className="font-sans tracking-normal" />
            <KindBadge link={link} className="font-sans tracking-normal" />
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
          {link.takenDown && <TakenDownBanner link={link} />}
          <TestModeBanner link={link} />
          <Totals link={link} />
          {donors?.ok && <DonorsPanel key={`${link._id}-${link.paymentsCount}`} linkId={link._id} initial={donors.data} />}
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

/** LinkPay staff paused the link (usually after a report). The reason stays with them. */
function TakenDownBanner({ link }: { link: PaymentLink }) {
  return (
    <Alert variant="destructive">
      <ShieldAlert aria-hidden />
      <AlertTitle>Paused by LinkPay</AlertTitle>
      <AlertDescription>
        Since {formatDateTime(link.takenDown!.at)}, the page hasn&apos;t taken {link.kind === "donation" ? "donations" : "payments"} while we review
        it. Only LinkPay can turn it back on. Contact support to find out more.
      </AlertDescription>
    </Alert>
  )
}

function Totals({ link }: { link: PaymentLink }) {
  const d = link.donation
  if (d) {
    const pct = d.goalKobo ? Math.min(100, (d.raisedKobo / d.goalKobo) * 100) : 0
    return (
      <section aria-label="Raised" className="surface grid gap-5 p-6 sm:p-8">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
          <div className="grid gap-1.5">
            <p className="text-sm text-muted-foreground">Raised</p>
            <p className="type-display text-[2.5rem] break-all sm:text-5xl figure">{formatNaira(d.raisedKobo)}</p>
          </div>
          {d.goalKobo && (
            <p className="text-sm text-muted-foreground sm:text-right">
              <span className="figure font-medium text-foreground">{d.percent}%</span> of the <span className="figure">{formatNaira(d.goalKobo)}</span> goal
            </p>
          )}
        </div>
        {d.goalKobo && (
          <div
            role="progressbar"
            aria-label="Raised towards the goal"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(pct)}
            className="h-2.5 overflow-hidden rounded-full bg-muted"
          >
            <div className="h-full rounded-full bg-primary transition-[width] duration-700" style={{ width: `${pct}%` }} />
          </div>
        )}
        <p className="text-sm text-muted-foreground">
          {paymentsLabel(link)}
          {link.lastPaidAt ? `, the latest ${formatDateTime(link.lastPaidAt)}` : ""}
          {link.mode === "test" ? ". Live donations only." : ""}
          {!link.available && link.unavailableReason && link.unavailableReason !== "taken_down" ? `. ${UNAVAILABLE_LABELS[link.unavailableReason]}.` : ""}
        </p>
      </section>
    )
  }
  return (
    <section aria-label="Totals" className="surface grid gap-6 p-6 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end sm:p-8">
      <div className="grid gap-1.5">
        <p className="text-sm text-muted-foreground">Collected</p>
        <p className="type-display text-[2.5rem] break-all sm:text-5xl figure">{formatNaira(link.collectedKobo)}</p>
        <p className="text-sm text-muted-foreground">
          {paymentsLabel(link)}
          {link.lastPaidAt ? `, the latest ${formatDateTime(link.lastPaidAt)}` : ""}
          {link.mode === "test" ? ". Live payments only." : ""}
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
    ...(link.donation
      ? ([
          ["Goal", link.donation.goalKobo ? <span key="g" className="figure">{formatNaira(link.donation.goalKobo)}</span> : <span key="g" className="text-muted-foreground">No goal</span>],
          [
            "Quick picks",
            link.donation.suggestedAmountsKobo.length ? (
              <span key="p" className="figure">{link.donation.suggestedAmountsKobo.map(formatNaira).join(", ")}</span>
            ) : (
              <span key="p" className="text-muted-foreground">None</span>
            ),
          ],
          ["Smallest", link.minAmountKobo ? <span key="m" className="figure">{formatNaira(link.minAmountKobo)}</span> : <span key="m" className="text-muted-foreground">₦100</span>],
        ] as [string, React.ReactNode][])
      : ([["Amount", <span key="a" className="figure">{link.amountKobo ? formatNaira(link.amountKobo) : priceLabel(link)}</span>]] as [string, React.ReactNode][])),
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
    ["Mode", link.mode === "test" ? "Test: placeholder bank details, simulated payments" : "Live"],
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
