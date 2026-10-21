"use client"

import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { ArrowLeft, ArrowRight, CalendarX2, Check, CircleAlert, CircleSlash, Clock, Landmark, X } from "lucide-react"
import { CopyButton } from "@/components/accounts/copy-button"
import { NairaInput } from "@/components/savings/pocket-form-dialog"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import type { PublicCheckout, PublicPaymentLink } from "@/lib/api/types"
import { formatDateTime, formatNaira } from "@/lib/format"
import { countdown, publicLinkImageSrc } from "@/lib/payment-links"
import { koboToInput, parseNairaToKobo } from "@/lib/transfers"
import { cn } from "@/lib/utils"
import { AccountNumber, brandVars, LinkSummary, Money, Perforation, Secured, StepTrack, StepTimeline, type PayStep } from "./pay-parts"

export type EmbedMode = "popup" | "inline" | null

/** What the business's website passed in (embed.js or the page's own query string). */
export type Prefill = {
  name?: string
  email?: string
  phone?: string
  amountKobo?: number
  clientReference?: string
  metadata?: Record<string, string>
  /** The website's origin as embed.js saw it; the browser's own answer wins when there is one. */
  origin?: string
}

type Props = {
  data: PublicPaymentLink
  logoSrc: string | null
  initialCheckout: PublicCheckout | null
  embed: EmbedMode
  /** Set by embed.js so it can tell its frames apart. */
  frameId?: string
  prefill: Prefill
}

/** The checkout summary the business's website gets (callbacks and events). */
const summary = (c: PublicCheckout) => ({
  token: c.token,
  reference: c.reference,
  status: c.status,
  priceKobo: c.priceKobo,
  amountKobo: c.amountKobo,
  paidKobo: c.paidKobo,
  clientReference: c.clientReference,
  metadata: c.metadata,
})

/** The website we're embedded in: the browser's ancestor list, then what embed.js said, then the referrer. */
function parentOrigin(param?: string) {
  try {
    const ancestors = (window.location as Location & { ancestorOrigins?: DOMStringList }).ancestorOrigins
    if (ancestors?.length) return ancestors[0]
  } catch {}
  if (param) return param
  try {
    return document.referrer ? new URL(document.referrer).origin : undefined
  } catch {
    return undefined
  }
}

const POLL_MS = 5_000
const SLOW_POLL_MS = 15_000
/** The backend gives 30 minutes to pay (`payWithinMinutes`); the time bar drains over that. */
const PAY_WINDOW_MS = 30 * 60_000
/** The backend keeps matching a checkout's amount for 2 hours from the start (30 minutes to pay + 90). */
const WATCH_AFTER_EXPIRY_MS = 90 * 60_000

/** The main button, in the business's colour. */
const BIZ_BUTTON = "h-12 w-full bg-(--biz) text-[15px] text-(--on-biz) hover:bg-[color-mix(in_oklch,var(--biz),var(--on-biz)_14%)]"

export function PayClient({ data, logoSrc, initialCheckout, embed, frameId, prefill }: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [checkout, setCheckout] = useState<PublicCheckout | null>(initialCheckout)
  const target = useRef<string>("*")
  const sheet = useRef<HTMLElement>(null)

  const post = useCallback(
    (type: string, extra: Record<string, unknown> = {}) => {
      if (!embed || window.parent === window) return
      window.parent.postMessage({ source: "linkpay", type, frameId, ...extra }, target.current)
    },
    [embed, frameId],
  )

  useEffect(() => {
    if (!embed) return
    target.current = parentOrigin(prefill.origin) ?? "*"
    post("ready", initialCheckout ? { checkout: summary(initialCheckout) } : {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Inline frames grow with the page.
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (embed !== "inline" || !root.current) return
    const el = root.current
    const send = () => post("resize", { height: Math.ceil(el.getBoundingClientRect().height) })
    const observer = new ResizeObserver(send)
    observer.observe(el)
    send()
    return () => observer.disconnect()
  }, [embed, post])

  // The URL carries the checkout so a refresh comes back to it.
  const setUrlCheckout = (token: string | null) => {
    const params = new URLSearchParams(searchParams.toString())
    if (token) params.set("checkout", token)
    else params.delete("checkout")
    router.replace(`${pathname}?${params}`, { scroll: false })
  }

  // On a phone the form is long: bring the top of the sheet back into view when its step changes.
  const showSheetTop = () => {
    if (embed) return
    requestAnimationFrame(() => {
      const el = sheet.current
      if (el && el.getBoundingClientRect().top < 0) el.scrollIntoView({ block: "start", behavior: "smooth" })
    })
  }

  // The status the website was last told about, so each change is reported once.
  const lastStatus = useRef(initialCheckout?.status)

  function started(c: PublicCheckout) {
    lastStatus.current = c.status
    setCheckout(c)
    setUrlCheckout(c.token)
    post("checkout", { checkout: summary(c) })
    showSheetTop()
  }

  const updated = useCallback(
    (c: PublicCheckout) => {
      if (lastStatus.current && lastStatus.current !== c.status) {
        post("update", { checkout: summary(c) })
        if (c.status === "paid") post("paid", { checkout: summary(c), redirectUrl: c.redirectUrl })
      }
      lastStatus.current = c.status
      setCheckout(c)
    },
    [post],
  )

  function startAgain() {
    lastStatus.current = undefined
    setCheckout(null)
    setUrlCheckout(null)
    showSheetTop()
  }

  const close = () => post("close", checkout ? { checkout: summary(checkout) } : {})

  // Focus is inside the frame, so the website never sees Escape: ask it to close the popup.
  const onEscape = useEffectEvent(close)
  useEffect(() => {
    if (embed !== "popup") return
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onEscape()
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [embed])

  const { business, link } = data
  const vars = brandVars(business.palette)
  const images = (link.images ?? []).map((img) => ({ src: publicLinkImageSrc(link.slug, img), width: img.width, height: img.height }))
  const step: PayStep = !checkout ? (data.available ? 0 : -1) : checkout.status === "paid" ? 2 : 1

  // Keyed by step so each step makes its own entrance.
  const body = checkout ? (
    <CheckoutPanel key={`c-${checkout.status === "paid" ? "paid" : "open"}`} checkout={checkout} embed={embed} onUpdate={updated} onBack={startAgain} />
  ) : data.available ? (
    <PayForm key="form" data={data} embed={embed} prefill={prefill} onStarted={started} />
  ) : (
    <Unavailable data={data} />
  )

  const summaryProps = {
    businessName: business.name,
    logoSrc,
    title: link.title,
    description: link.description,
    amountKobo: link.amountKobo,
    minAmountKobo: link.minAmountKobo,
    images,
    titleId: "pay-title",
  }

  if (embed) {
    const card = (
      <article style={vars} className="pay-brand surface overflow-hidden" aria-labelledby="pay-title">
        <header className="grain bg-(--biz) px-6 pt-6 pb-7 text-(--on-biz) sm:px-8">
          <LinkSummary
            {...summaryProps}
            variant="compact"
            action={
              embed === "popup" && (
                <button
                  type="button"
                  onClick={close}
                  aria-label="Close"
                  className="-my-1 grid size-9 shrink-0 place-items-center rounded-full bg-[color-mix(in_oklch,var(--on-biz)_12%,transparent)] transition-colors hover:bg-[color-mix(in_oklch,var(--on-biz)_22%,transparent)] focus-visible:ring-3 focus-visible:ring-(--on-biz)/60 focus-visible:outline-none"
                >
                  <X className="size-4" aria-hidden />
                </button>
              )
            }
          />
        </header>
        <StepTrack step={step} className="px-6 pt-6 sm:px-8" />
        {body}
      </article>
    )
    const footer = <Secured businessName={business.name} className={cn("text-center", embed === "popup" ? "text-white/80" : "text-muted-foreground")} />

    if (embed === "popup") {
      return (
        <div
          className="fixed inset-0 overflow-y-auto bg-[oklch(0.2_0.03_252/0.6)] backdrop-blur-[2px]"
          onClick={(e) => e.target === e.currentTarget && close()}
        >
          <div className="mx-auto grid max-w-md gap-4 px-4 py-6 sm:py-12" onClick={(e) => e.target === e.currentTarget && close()}>
            {card}
            {footer}
          </div>
        </div>
      )
    }
    return (
      <div ref={root} className="mx-auto grid max-w-md gap-3 p-1">
        {card}
        {footer}
      </div>
    )
  }

  // Its own page: the business's colour owns the left of the screen (the top on a phone), and the
  // sheet where the payer works sits on LinkPay's paper, overlapping the band on a phone.
  return (
    <main style={vars} className="pay-brand min-h-dvh bg-background lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <aside className="grain bg-(--biz) text-(--on-biz)">
        <div className="mx-auto flex w-full max-w-120 flex-col gap-10 px-5 pt-7 pb-24 sm:px-0 sm:pt-10 lg:sticky lg:top-0 lg:h-dvh lg:max-w-none lg:justify-between lg:px-12 lg:py-12 xl:px-16 xl:py-14 short:gap-6 short:py-8">
          <LinkSummary {...summaryProps} variant="panel" fitScreen />
          {step >= 0 && (
            <div className="hidden gap-6 lg:grid">
              <StepTimeline step={step} dense={images.length > 0} />
              <Secured businessName={business.name} className="text-(--biz-muted)" />
            </div>
          )}
        </div>
      </aside>

      <div className="relative z-10 -mt-16 px-4 pb-10 sm:px-6 lg:mt-0 lg:flex lg:min-h-dvh lg:flex-col lg:items-center lg:justify-center lg:px-12 lg:py-10 short:py-4">
        <div className="mx-auto grid w-full max-w-120 gap-5">
          <section ref={sheet} aria-label="Payment" className="surface scroll-mt-4 overflow-hidden">
            <StepTrack step={step} className="px-6 pt-6 sm:px-8 lg:hidden" />
            {body}
          </section>
          <Secured businessName={business.name} className={cn("text-center text-muted-foreground", step >= 0 && "lg:hidden")} />
        </div>
      </div>
    </main>
  )
}

// ---------------------------------------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------------------------------------

function PayForm({ data, embed, prefill, onStarted }: { data: PublicPaymentLink; embed: EmbedMode; prefill: Prefill; onStarted: (c: PublicCheckout) => void }) {
  const { link } = data
  const open = !link.amountKobo
  // The website set the amount (its cart total): shown, not editable.
  const lockedAmount = open && embed && prefill.amountKobo ? prefill.amountKobo : null
  const [name, setName] = useState(prefill.name ?? "")
  const [email, setEmail] = useState(prefill.email ?? "")
  const [phone, setPhone] = useState(prefill.phone ?? "")
  const [amount, setAmount] = useState(prefill.amountKobo && open ? koboToInput(prefill.amountKobo).replace(/\.00$/, "") : "")
  const [fields, setFields] = useState<Record<string, string>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  const min = link.minAmountKobo ?? 100_00
  const max = link.maxAmountKobo ?? 100_000_000_00

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const next: Record<string, string> = {}
    if (name.trim().length < 2) next.name = "Enter your name."
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) next.email = "Enter a valid email address, for your receipt."
    if (link.phone === "required" && !phone.trim()) next.phone = "Enter your phone number."
    if (phone.trim() && !/^\+?[0-9 ()-]{7,20}$/.test(phone.trim())) next.phone = "Enter a valid phone number."
    let amountKobo: number | undefined
    if (open) {
      amountKobo = lockedAmount ?? parseNairaToKobo(amount) ?? undefined
      if (!amountKobo || amountKobo < min || amountKobo > max) next.amountKobo = `Enter an amount from ${formatNaira(min)} to ${formatNaira(max)}.`
    }
    for (const f of link.customFields) if (f.required && !fields[f._id]?.trim()) next[`fields.${f._id}`] = `Fill in "${f.label}".`
    setErrors(next)
    if (Object.keys(next).length) return

    setBusy(true)
    setError(undefined)
    const body = {
      name: name.trim(),
      email: email.trim(),
      ...(link.phone !== "off" && phone.trim() && { phone: phone.trim() }),
      ...(amountKobo && { amountKobo }),
      fields: Object.fromEntries(Object.entries(fields).filter(([, v]) => v.trim())),
      ...(embed && {
        source: "embed",
        embedOrigin: parentOrigin(prefill.origin),
      }),
      ...(prefill.clientReference && {
        clientReference: prefill.clientReference,
      }),
      ...(prefill.metadata && Object.keys(prefill.metadata).length && { metadata: prefill.metadata }),
    }
    let res: Response
    try {
      res = await fetch(`/api/pay/${encodeURIComponent(link.slug)}/checkouts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    } catch {
      setBusy(false)
      return setError("We couldn't reach LinkPay. Check your connection and try again.")
    }
    const json = await res.json().catch(() => null)
    setBusy(false)
    if (res.ok && json) return onStarted(json as PublicCheckout)
    setError(payErrorMessage(json?.code, json?.error))
    const field = json?.details?.field as string | undefined
    if (json?.code === "FIELD_REQUIRED" && field)
      setErrors({
        [field === "phone" ? "phone" : `fields.${field}`]: json.error,
      })
    if (json?.code === "INVALID_AMOUNT") setErrors({ amountKobo: json.error })
    if (Array.isArray(json?.details)) {
      const fe: Record<string, string> = {}
      for (const issue of json.details as {
        path: (string | number)[]
        message: string
      }[])
        fe[issue.path.join(".")] ??= issue.message
      setErrors(fe)
    }
  }

  return (
    <form onSubmit={submit} noValidate className="page-enter grid gap-5 px-6 pt-6 pb-7 sm:px-8 sm:pt-8 sm:pb-8 short:gap-3.5 short:pt-6 short:pb-6">
      <div className="grid gap-1">
        <h2 className="type-display text-2xl">Your details</h2>
        <p className="text-sm text-muted-foreground">Next, we show you the account to send the money to.</p>
      </div>
      {error && (
        <p role="alert" className="flex gap-2 rounded-xl bg-destructive-subtle px-3.5 py-3 text-sm text-destructive">
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          {error}
        </p>
      )}
      {open &&
        (lockedAmount ? (
          <div className="grid gap-0.5 rounded-xl bg-(--biz-soft) px-4 py-3">
            <span className="text-xs text-muted-foreground">Amount</span>
            <span className="type-display text-2xl">
              <Money kobo={lockedAmount} />
            </span>
            {errors.amountKobo && <span className="text-sm text-destructive">{errors.amountKobo}</span>}
          </div>
        ) : (
          <Field data-invalid={!!errors.amountKobo}>
            <FieldLabel htmlFor="pay-amount">Amount</FieldLabel>
            <NairaInput id="pay-amount" value={amount} invalid={!!errors.amountKobo} onChange={setAmount} autoFocus={!embed} />
            {errors.amountKobo ? (
              <FieldError>{errors.amountKobo}</FieldError>
            ) : (
              <FieldDescription>
                {link.minAmountKobo && link.minAmountKobo > 100_00 ? `At least ${formatNaira(link.minAmountKobo)}.` : "Enter what you're paying."}
              </FieldDescription>
            )}
          </Field>
        ))}
      <Field data-invalid={!!errors.name}>
        <FieldLabel htmlFor="pay-name">Your name</FieldLabel>
        <Input
          id="pay-name"
          autoComplete="name"
          maxLength={100}
          value={name}
          aria-invalid={!!errors.name}
          onChange={(e) => setName(e.target.value)}
          className="h-11 short:h-10"
        />
        {errors.name && <FieldError>{errors.name}</FieldError>}
      </Field>
      <Field data-invalid={!!errors.email}>
        <FieldLabel htmlFor="pay-email">Email</FieldLabel>
        <Input
          id="pay-email"
          type="email"
          inputMode="email"
          autoComplete="email"
          maxLength={200}
          value={email}
          aria-invalid={!!errors.email}
          onChange={(e) => setEmail(e.target.value)}
          className="h-11 short:h-10"
        />
        {errors.email ? <FieldError>{errors.email}</FieldError> : <FieldDescription>We&apos;ll email your receipt here.</FieldDescription>}
      </Field>
      {link.phone !== "off" && (
        <Field data-invalid={!!errors.phone}>
          <FieldLabel htmlFor="pay-phone">Phone number{link.phone === "optional" ? " (optional)" : ""}</FieldLabel>
          <Input
            id="pay-phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            maxLength={20}
            value={phone}
            aria-invalid={!!errors.phone}
            onChange={(e) => setPhone(e.target.value)}
            className="h-11 short:h-10"
          />
          {errors.phone && <FieldError>{errors.phone}</FieldError>}
        </Field>
      )}
      {link.customFields.map((f) => {
        const key = `fields.${f._id}`
        return (
          <Field key={f._id} data-invalid={!!errors[key]}>
            <FieldLabel htmlFor={`pay-f-${f._id}`}>
              {f.label}
              {f.required ? "" : " (optional)"}
            </FieldLabel>
            <Input
              id={`pay-f-${f._id}`}
              maxLength={500}
              value={fields[f._id] ?? ""}
              aria-invalid={!!errors[key]}
              onChange={(e) => setFields((prev) => ({ ...prev, [f._id]: e.target.value }))}
              className="h-11 short:h-10"
            />
            {errors[key] && <FieldError>{errors[key]}</FieldError>}
          </Field>
        )
      })}
      <Button type="submit" size="lg" disabled={busy} className={cn(BIZ_BUTTON, "mt-2")}>
        {busy ? <Spinner /> : <Landmark data-icon="inline-start" aria-hidden />}
        Pay by bank transfer
      </Button>
    </form>
  )
}

/** Copy for the payer, who has no LinkPay account: never mentions roles or the dashboard. */
function payErrorMessage(code?: string, fallback?: string) {
  switch (code) {
    case "PAYMENT_LINK_UNAVAILABLE":
      return "This link isn't taking payments right now."
    case "CHECKOUT_BUSY":
      return "Lots of people are paying this amount right now. Try again in a few minutes."
    case "EMBED_NOT_ALLOWED":
      return "This payment can't be made from this website. Open the business's payment link directly."
    case "TOO_MANY_CHECKOUTS":
      return "Too many attempts. Wait a few minutes and try again."
    case "ACCOUNT_NOT_READY":
      return "This business can't take payments yet. Try again later."
    case "API_UNREACHABLE":
      return "We couldn't reach LinkPay. Check your connection and try again."
    case "FIELD_REQUIRED":
    case "INVALID_AMOUNT":
      return fallback ?? "Check the highlighted fields."
    default:
      return fallback && fallback !== "Validation failed" ? fallback : "Check the highlighted fields and try again."
  }
}

function Unavailable({ data }: { data: PublicPaymentLink }) {
  const reason = data.unavailableReason
  const text =
    reason === "expired"
      ? "This link has ended and isn't taking payments any more."
      : reason === "sold_out"
        ? "This link has reached its limit and isn't taking more payments."
        : reason === "account_not_ready"
          ? "This business can't take payments yet. Try again later."
          : "This link isn't taking payments right now."
  const Icon = reason === "expired" ? CalendarX2 : reason === "account_not_ready" ? Clock : CircleSlash
  return (
    <div className="page-enter grid gap-5 px-6 py-8 sm:px-8 sm:py-10">
      <span className="grid size-12 place-items-center rounded-[30%] bg-muted text-muted-foreground">
        <Icon className="size-6" aria-hidden />
      </span>
      <div className="grid gap-1.5">
        <h2 className="type-display text-2xl">Not taking payments</h2>
        <p className="text-[15px] leading-relaxed text-muted-foreground">
          {text} Contact {data.business.name} if you need to pay them.
        </p>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------------
// The checkout: what to send, where, and whether it's arrived
// ---------------------------------------------------------------------------------------------------------

function CheckoutPanel({
  checkout: c,
  embed,
  onUpdate,
  onBack,
}: {
  checkout: PublicCheckout
  embed: EmbedMode
  onUpdate: (c: PublicCheckout) => void
  onBack: () => void
}) {
  const [now, setNow] = useState(() => Date.now())
  const waiting = c.status === "pending" || c.status === "expired"
  const watchedUntil = Date.parse(c.expiresAt) + WATCH_AFTER_EXPIRY_MS
  const watching = waiting && now < watchedUntil

  // Countdown.
  useEffect(() => {
    if (!waiting) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [waiting])

  // Poll while we're still watching for the transfer; slower once the time is up, paused while hidden.
  const expired = now >= Date.parse(c.expiresAt)
  useEffect(() => {
    if (!watching) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const tick = async () => {
      if (document.visibilityState === "visible") {
        try {
          const res = await fetch(`/api/pay/checkouts/${encodeURIComponent(c.token)}`, { cache: "no-store" })
          if (res.ok && !stopped) onUpdate((await res.json()) as PublicCheckout)
        } catch {}
      }
      if (!stopped) timer = setTimeout(tick, expired ? SLOW_POLL_MS : POLL_MS)
    }
    timer = setTimeout(tick, POLL_MS)
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [c.token, watching, expired, onUpdate])

  if (c.status === "paid") return <Paid checkout={c} embed={embed} />
  if (c.status === "underpaid") return <Underpaid checkout={c} />

  const amountText = koboToInput(c.amountKobo)
  const extraKobo = c.amountKobo - c.priceKobo
  const left = Math.max(0, Date.parse(c.expiresAt) - now)
  return (
    <div className="slip-in">
      <div className="grid gap-3 px-6 pt-6 sm:px-8 sm:pt-8 short:gap-2 short:pt-6">
        <h2 className="text-sm font-medium text-muted-foreground">Transfer exactly</h2>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
          <p className="type-display text-[2.75rem] leading-none sm:text-5xl">
            <Money kobo={c.amountKobo} highlight={extraKobo > 0} />
          </p>
          <CopyButton value={amountText} message="Amount copied" label="Copy amount" variant="outline">
            Copy<span className="sr-only"> amount</span>
          </CopyButton>
        </div>
        {extraKobo > 0 && (
          <p className="text-sm leading-relaxed text-pretty text-muted-foreground">
            The extra <span className="figure font-medium text-foreground">{extraKobo} kobo</span> lets us spot your transfer. Send it to the kobo.
          </p>
        )}
      </div>

      <Perforation notched={!embed} />

      {c.payTo ? (
        <dl className="grid gap-5 px-6 pb-6 sm:px-8 sm:pb-7 short:gap-3.5 short:pb-5">
          <div className="grid gap-1">
            <dt className="text-xs text-muted-foreground">Account number</dt>
            <dd className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
              <AccountNumber value={c.payTo.accountNumber} className="text-[1.75rem] leading-none sm:text-[2rem]" />
              <CopyButton value={c.payTo.accountNumber} message="Account number copied" label="Copy account number" variant="outline">
                Copy<span className="sr-only"> account number</span>
              </CopyButton>
            </dd>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-1">
              <dt className="text-xs text-muted-foreground">Bank</dt>
              <dd className="text-[15px] font-medium">{c.payTo.bankName ?? "Shown in your bank app"}</dd>
            </div>
            <div className="grid gap-1">
              <dt className="text-xs text-muted-foreground">Account name</dt>
              <dd className="text-[15px] font-medium">{c.payTo.accountName ?? c.business.name}</dd>
            </div>
          </div>
          <div className="grid gap-1 rounded-xl bg-(--biz-soft) py-2.5 pr-2 pl-4">
            <dt className="text-xs text-muted-foreground">Narration (if your bank asks)</dt>
            <dd className="flex items-center justify-between gap-2">
              <span className="font-mono text-[15px] font-medium">{c.reference}</span>
              <CopyButton value={c.reference} message="Reference copied" label="Copy reference" />
            </dd>
          </div>
        </dl>
      ) : (
        <p className="mx-6 mb-6 rounded-xl bg-muted/60 px-4 py-3 text-sm text-muted-foreground sm:mx-8">This business can&apos;t take payments right now.</p>
      )}

      <div className="grid gap-3 border-t px-6 py-5 sm:px-8 short:gap-2 short:py-4">
        <div className="flex items-center gap-3">
          {watching ? (
            <span className="relative flex size-2.5 shrink-0" aria-hidden>
              <span className="absolute inset-0 animate-ping rounded-full bg-(--biz-strong) opacity-60" />
              <span className="relative size-2.5 rounded-full bg-(--biz-strong)" />
            </span>
          ) : (
            <Clock className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          )}
          <p role="status" aria-live="polite" className="text-[15px] font-medium">
            {!expired ? "Waiting for your transfer" : watching ? "Your time to pay is up" : "We've stopped watching for this transfer"}
          </p>
          {!expired && (
            <p className="ml-auto type-display text-2xl leading-none figure">
              <span className="sr-only">Time left </span>
              {countdown(c.expiresAt, now)}
            </p>
          )}
        </div>
        {!expired && (
          <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
            <div
              className="h-full rounded-full bg-(--biz-strong) transition-[width] duration-1000 ease-linear"
              style={{
                width: `${Math.min(100, (left / PAY_WINDOW_MS) * 100)}%`,
              }}
            />
          </div>
        )}
        <p className="text-sm leading-relaxed text-pretty text-muted-foreground">
          {!expired ? (
            "Send it before the time runs out. This page updates by itself once it lands."
          ) : watching ? (
            "If you've already sent it, keep this page open. We'll still pick it up."
          ) : (
            <>
              If you sent it, {c.business.name} can still match it. Give them the reference <span className="font-mono text-foreground">{c.reference}</span>.
            </>
          )}
        </p>
      </div>

      <div className="px-6 pb-6 sm:px-8 short:pb-5">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex w-fit items-center gap-1.5 rounded-md text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:underline focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <ArrowLeft className="size-4" aria-hidden />
          Change my details
        </button>
      </div>
    </div>
  )
}

/** Hairline rows of facts, as on a receipt. */
function Receipt({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <dl className="grid border-t text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="flex items-baseline justify-between gap-4 border-b py-3">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 text-right font-medium break-all">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

function Underpaid({ checkout: c }: { checkout: PublicCheckout }) {
  return (
    <div className="page-enter grid gap-6 px-6 pt-6 pb-7 sm:px-8 sm:pt-8 sm:pb-8" role="status">
      <span className="grid size-14 place-items-center rounded-[30%] bg-warning-subtle text-warning-foreground">
        <CircleAlert className="size-7" aria-hidden />
      </span>
      <div className="grid gap-2">
        <h2 className="type-display text-[2rem]">Part payment received</h2>
        <p className="text-[15px] leading-relaxed text-muted-foreground">
          {c.business.name} received part of the price. Contact them about the rest, quoting the reference below.
        </p>
      </div>
      <Receipt
        rows={[
          [
            "Received",
            <span key="r" className="figure">
              {formatNaira(c.paidKobo ?? 0)}
            </span>,
          ],
          [
            "Price",
            <span key="p" className="figure">
              {formatNaira(c.priceKobo)}
            </span>,
          ],
          [
            "Reference",
            <span key="ref" className="font-mono">
              {c.reference}
            </span>,
          ],
        ]}
      />
    </div>
  )
}

function Paid({ checkout: c, embed }: { checkout: PublicCheckout; embed: EmbedMode }) {
  // On its own page, a link with a redirect sends the payer on after a moment.
  useEffect(() => {
    if (embed || !c.redirectUrl) return
    const id = setTimeout(() => window.location.assign(c.redirectUrl!), 5000)
    return () => clearTimeout(id)
  }, [embed, c.redirectUrl])

  const rows: [string, React.ReactNode][] = [
    [
      "Amount paid",
      <span key="a" className="figure">
        {formatNaira(c.paidKobo ?? c.amountKobo)}
      </span>,
    ],
  ]
  if (c.paidAt) rows.push(["Paid on", formatDateTime(c.paidAt)])
  rows.push([
    "Reference",
    <span key="r" className="font-mono">
      {c.reference}
    </span>,
  ])
  if (c.clientReference)
    rows.push([
      "Your order",
      <span key="o" className="font-mono">
        {c.clientReference}
      </span>,
    ])

  return (
    <div className="page-enter grid gap-6 px-6 pt-6 pb-7 sm:px-8 sm:pt-8 sm:pb-8" role="status">
      <span className="pop-in grid size-14 place-items-center rounded-[30%] bg-(--biz) text-(--on-biz) shadow-[0_10px_24px_-10px_oklch(0.15_0.03_252/0.5)]">
        <Check className="size-7" strokeWidth={2.5} aria-hidden />
      </span>
      <div className="grid gap-2">
        <h2 className="type-display text-[2rem]">Payment received</h2>
        <p className="text-[15px] leading-relaxed text-muted-foreground">
          {c.business.name} has your payment. We&apos;ve emailed a receipt to <span className="text-foreground">{c.payer.email}</span>.
        </p>
      </div>
      {c.successMessage && (
        <figure className="grid gap-1 rounded-xl bg-(--biz-soft) px-4 py-3.5">
          <figcaption className="text-xs text-muted-foreground">From {c.business.name}</figcaption>
          <p className="text-[15px] leading-relaxed whitespace-pre-line">{c.successMessage}</p>
        </figure>
      )}
      <Receipt rows={rows} />
      {c.redirectUrl && (
        <div className="grid gap-2">
          <Button asChild size="lg" className={BIZ_BUTTON}>
            {/* _top so it leaves the frame when embedded. */}
            <a href={c.redirectUrl} target={embed ? "_top" : undefined}>
              Continue
              <ArrowRight data-icon="inline-end" aria-hidden />
            </a>
          </Button>
          {!embed && <p className="text-center text-xs text-muted-foreground">Taking you there in a few seconds.</p>}
        </div>
      )}
    </div>
  )
}
