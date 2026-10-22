"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { FlaskConical, Link2 } from "lucide-react"
import { toast } from "sonner"
import { checkoutSuggestions, matchCheckout, simulateCheckout } from "@/app/(dashboard)/payment-links/actions"
import { CopyButton } from "@/components/accounts/copy-button"
import { FormError } from "@/components/common/form-error"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import type { LinkCheckout, SuggestedPayment } from "@/lib/api/types"
import { formatDateTime, formatNaira, formatShortDate } from "@/lib/format"
import { MATCHED_BY_LABELS, originLabel, uniqueKobo } from "@/lib/payment-links"
import { cn } from "@/lib/utils"
import { CheckoutStatusBadge, TestBadge } from "./parts"

/** One payer's checkout: what they were asked to send, what came in and how it was matched. */
export function CheckoutSheet({ checkout, onClose }: { checkout: LinkCheckout | null; onClose: () => void }) {
  return (
    <Sheet open={!!checkout} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="gap-0 overflow-y-auto p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-md">
        {checkout && <Details key={`${checkout._id}-${checkout.status}`} checkout={checkout} />}
      </SheetContent>
    </Sheet>
  )
}

function Details({ checkout: c }: { checkout: LinkCheckout }) {
  const received = c.status === "paid" || c.status === "underpaid"
  const metadata = Object.entries(c.metadata ?? {})

  return (
    <>
      <SheetHeader className="gap-4 border-b bg-muted/50 p-6 pr-14">
        <span className="flex items-center gap-1.5">
          <CheckoutStatusBadge status={c.status} />
          <TestBadge mode={c.mode} />
        </span>
        <div className="grid gap-1.5">
          <SheetDescription className="text-foreground">
            <span className="font-display text-lg font-semibold tracking-[-0.02em]">{c.payer.name}</span>
            {c.link && <span className="text-muted-foreground">, {c.link.title}</span>}
          </SheetDescription>
          <SheetTitle className="type-display text-4xl font-normal figure">
            <span className="sr-only">Amount: </span>
            {formatNaira(received ? (c.paidKobo ?? 0) : c.priceKobo)}
          </SheetTitle>
          <p className="text-sm text-muted-foreground">
            {c.status === "underpaid"
              ? `Part paid: ${formatNaira(c.priceKobo - (c.paidKobo ?? 0))} short of ${formatNaira(c.priceKobo)}.`
              : received
                ? `Received ${formatDateTime(c.paidAt ?? undefined)}.`
                : c.mode === "test"
                  ? c.donor
                    ? "A test gift: no money moves. Simulate it below to see it land on the fundraiser's page."
                    : "A test payment: no money moves. Simulate the transfer below to see what happens when one arrives."
                  : c.status === "expired"
                    ? "Their time to pay ran out with nothing matched. A late transfer can still be linked below."
                    : `Waiting for their transfer until ${formatDateTime(c.expiresAt)}.`}
          </p>
        </div>
      </SheetHeader>

      <dl className="grid gap-4 border-b p-6 text-sm">
        <Row label="Reference">
          <span className="flex items-center gap-1">
            <span className="font-mono">{c.reference}</span>
            <CopyButton value={c.reference} message="Reference copied" label="Copy reference" size="icon-xs" />
          </span>
        </Row>
        <Row label="Asked to send">
          <span className="figure">{formatNaira(c.amountKobo)}</span>
          <span className="block text-xs text-muted-foreground">
            The price plus {uniqueKobo(c)} kobo, so the transfer can be told apart.
          </span>
        </Row>
        {received && c.matchedBy && (
          <Row label="How it matched">
            {MATCHED_BY_LABELS[c.matchedBy]}
            {c.matchedByUser ? ` by ${c.matchedByUser.name}` : ""}
          </Row>
        )}
        <Row label="Started">{formatDateTime(c.createdAt)}</Row>
        {c.branch && <Row label="Paid into">{c.branch.name}</Row>}
        <Row label="Started on">
          {c.source === "embed" ? (
            <>
              Your website
              {c.embedOrigin && <span className="block font-mono text-xs text-muted-foreground">{originLabel(c.embedOrigin)}</span>}
            </>
          ) : (
            "The link's page"
          )}
        </Row>
        {c.clientReference && (
          <Row label="Your order">
            <span className="font-mono">{c.clientReference}</span>
          </Row>
        )}
      </dl>

      <section aria-labelledby="payer-title" className="grid gap-3 border-b p-6 text-sm">
        <h3 id="payer-title" className="font-medium">
          {c.donor ? "Donor" : "Customer"}
        </h3>
        <dl className="grid gap-3">
          <Row label="Email">
            <a href={`mailto:${c.payer.email}`} className="underline-offset-4 hover:underline">
              {c.payer.email}
            </a>
          </Row>
          {c.payer.phone && (
            <Row label="Phone">
              <a href={`tel:${c.payer.phone}`} className="figure underline-offset-4 hover:underline">
                {c.payer.phone}
              </a>
            </Row>
          )}
          {c.payer.fields.map((f) => (
            <Row key={f.label} label={f.label}>
              <span className="whitespace-pre-line">{f.value}</span>
            </Row>
          ))}
          {c.donor && (
            <>
              <Row label="On the page">
                {c.hiddenFromPage ? "Hidden by LinkPay" : c.donor.anonymous ? "As Anonymous" : `Under their name`}
              </Row>
              {c.donor.message && (
                <Row label="Message">
                  <span className="whitespace-pre-line">&ldquo;{c.donor.message}&rdquo;</span>
                </Row>
              )}
            </>
          )}
        </dl>
      </section>

      {metadata.length > 0 && (
        <section aria-labelledby="meta-title" className="grid gap-3 border-b p-6 text-sm">
          <h3 id="meta-title" className="font-medium">
            Sent by your website
          </h3>
          <dl className="grid gap-2">
            {metadata.map(([k, value]) => (
              <Row key={k} label={<span className="font-mono">{k}</span>}>
                <span className="break-all">{value}</span>
              </Row>
            ))}
          </dl>
        </section>
      )}

      {c.canMatch && <LinkPayment checkout={c} />}
      {c.canSimulate && <SimulatePayment checkout={c} />}
    </>
  )
}

function Row({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[8.5rem_minmax(0,1fr)] gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  )
}

/** Test checkouts: pay it as if the transfer had arrived, to try the notification, receipt and the website's flow. */
function SimulatePayment({ checkout }: { checkout: LinkCheckout }) {
  const [busy, setBusy] = useState<"paid" | "underpaid" | null>(null)
  const [error, setError] = useState<string>()
  // A donation checkout: any amount that arrives is a whole gift, so there's no part payment to try.
  const donation = !!checkout.donor

  async function simulate(outcome: "paid" | "underpaid") {
    setBusy(outcome)
    setError(undefined)
    const result = await simulateCheckout(checkout._id, outcome, checkout.link?._id)
    setBusy(null)
    if (!result.ok) return setError(result.error)
    toast.success(
      donation
        ? "Test gift received. It shows on the fundraiser's page until the link goes live."
        : outcome === "paid"
          ? "Test payment received. We've emailed a test receipt."
          : "Test part payment received.",
    )
  }

  return (
    <section aria-labelledby="simulate-title" className="grid gap-4 p-6">
      <div className="grid gap-1">
        <h3 id="simulate-title" className="text-sm font-medium">
          {donation ? "Simulate the gift" : "Simulate the payment"}
        </h3>
        <p className="text-sm text-muted-foreground">
          {donation
            ? `Marks this test gift as received, as if ${checkout.payer.name}'s transfer had arrived. It shows on the fundraiser's page until the link goes live.`
            : `Marks this test checkout as paid, as if ${checkout.payer.name}'s transfer had arrived. A part payment sends half the price.`}
        </p>
      </div>
      <FormError message={error} />
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => simulate("paid")} disabled={!!busy}>
          {busy === "paid" ? <Spinner /> : <FlaskConical data-icon="inline-start" aria-hidden />}
          {donation ? "Simulate the gift" : "Simulate payment"}
        </Button>
        {!donation && (
          <Button variant="outline" onClick={() => simulate("underpaid")} disabled={!!busy}>
            {busy === "underpaid" && <Spinner />}
            Simulate part payment
          </Button>
        )}
      </div>
    </section>
  )
}

/** For transfers the matcher missed (a round amount with no reference): pick one and link it. */
function LinkPayment({ checkout }: { checkout: LinkCheckout }) {
  const [suggestions, setSuggestions] = useState<SuggestedPayment[] | null>(null)
  const [loadError, setLoadError] = useState<string>()
  const [picked, setPicked] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    let live = true
    checkoutSuggestions(checkout._id).then((r) => {
      if (!live) return
      if (r.ok) {
        setSuggestions(r.data)
        setPicked(r.data.find((s) => s.exactAmount)?._id)
      } else setLoadError(r.error)
    })
    return () => {
      live = false
    }
  }, [checkout._id])

  async function link() {
    if (!picked) return
    setBusy(true)
    setError(undefined)
    const result = await matchCheckout(checkout._id, picked, checkout.link?._id)
    setBusy(false)
    if (!result.ok) return setError(result.error)
    toast.success(result.data.status === "paid" ? "Payment linked. We've emailed the customer a receipt." : "Payment linked as a part payment.")
  }

  return (
    <section aria-labelledby="link-payment-title" className="grid gap-4 p-6">
      <div className="grid gap-1">
        <h3 id="link-payment-title" className="text-sm font-medium">
          Link a payment
        </h3>
        <p className="text-sm text-muted-foreground">
          If {checkout.payer.name} sent a round amount without the reference, pick their transfer here. Only unlinked transfers into{" "}
          {checkout.branch?.name ?? "this account"} since they started are shown.
        </p>
      </div>
      <FormError message={error ?? loadError} />
      {suggestions === null && !loadError ? (
        <div className="grid gap-2">
          <Skeleton className="h-14 rounded-xl" />
          <Skeleton className="h-14 rounded-xl" />
        </div>
      ) : suggestions && suggestions.length === 0 ? (
        <p className="rounded-xl border border-dashed px-4 py-5 text-center text-sm text-muted-foreground">
          No transfers that look like this one yet. Check{" "}
          <Link href="/transactions?direction=credit" className="underline underline-offset-4">
            money in
          </Link>{" "}
          if you&apos;re expecting one.
        </p>
      ) : (
        suggestions && (
          <>
            <ul role="radiogroup" aria-label="Transfers" className="grid gap-2">
              {suggestions.map((s) => (
                <li key={s._id}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={picked === s._id}
                    onClick={() => setPicked(s._id)}
                    className={cn(
                      "flex w-full items-start gap-3 rounded-xl border px-4 py-3 text-left text-sm transition-colors duration-150",
                      "focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                      picked === s._id ? "border-primary bg-muted/60" : "hover:bg-muted/40",
                    )}
                  >
                    <span className="grid min-w-0 flex-1 gap-0.5">
                      <span className="flex flex-wrap items-center gap-2 font-medium">
                        {s.counterparty.name ?? "Unknown sender"}
                        {s.exactAmount && <Badge variant="success">Exact amount</Badge>}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">
                        {formatShortDate(s.occurredAt)}
                        {s.narration ? ` · ${s.narration}` : ""}
                      </span>
                    </span>
                    <span className="font-medium figure">{formatNaira(s.amountKobo)}</span>
                  </button>
                </li>
              ))}
            </ul>
            <Button onClick={link} disabled={!picked || busy}>
              {busy ? <Spinner /> : <Link2 data-icon="inline-start" aria-hidden />}
              Link this payment
            </Button>
          </>
        )
      )}
    </section>
  )
}
