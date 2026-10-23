"use client"

import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { ArrowLeft, ArrowRight, CalendarX2, Check, CircleAlert, CircleSlash, Clock, FlaskConical, Landmark, RotateCcw, X } from "lucide-react"
import { CopyButton } from "@/components/accounts/copy-button"
import { NairaInput } from "@/components/common/naira-input"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import type { PublicCheckout, PublicDonation, PublicPaymentLink } from "@/lib/api/types"
import { formatDateTime, formatNaira } from "@/lib/format"
import { countdown, publicLinkImageSrc } from "@/lib/payment-links"
import { koboToInput, parseNairaToKobo } from "@/lib/transfers"
import { cn } from "@/lib/utils"
import { useLinkEvents } from "./use-link-events"
import {
  DonateBar,
  DonorOptions,
  FundraiserGallery,
  FundraiserProgress,
  GiftSteps,
  MAX_MESSAGE,
  naira,
  RaisedSummary,
  QuickPicks,
  ReportDialog,
  ReportLink,
  ShareButton,
  Ticket,
  TicketRoll,
  TicketStub,
  useDonationFeed,
  type GiftStep,
} from "./donation-parts"
import {
  AccountNumber,
  BIZ_BUTTON,
  brandVars,
  BusinessMark,
  LinkSummary,
  Money,
  Perforation,
  Secured,
  StepTrack,
  StepTimeline,
  type PayStep,
} from "./pay-parts"

export type EmbedMode = "popup" | "inline" | null

/**
 * What the business's website passed in: the page's own query string, or (name, email and phone from embed.js)
 * a `prefill` message once the frame is ready, so the payer's details stay out of the frame's address.
 */
export type Prefill = {
  name?: string
  email?: string
  phone?: string
  amountKobo?: number
  clientReference?: string
  metadata?: Record<string, string>
  /**
   * The website's origin as embed.js says (`?origin=`). Anyone who writes the frame's address can set it, so
   * it only picks where our messages go when the browser doesn't say; it's never sent as `embedOrigin`.
   */
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
  // "test": simulated, no money moved. The website's server should only fulfil "live" (and confirm it itself).
  mode: c.mode,
  priceKobo: c.priceKobo,
  amountKobo: c.amountKobo,
  paidKobo: c.paidKobo,
  clientReference: c.clientReference,
  metadata: c.metadata,
})

/**
 * The website we're embedded in, as the browser tells us: its ancestor list, then the referrer. Still only
 * advisory for the backend (`embedOrigin`); frame-ancestors is what keeps the page off other websites.
 */
function parentOrigin() {
  try {
    const ancestors = (window.location as Location & { ancestorOrigins?: DOMStringList }).ancestorOrigins
    if (ancestors?.length) return ancestors[0]
  } catch {}
  try {
    return document.referrer ? new URL(document.referrer).origin : undefined
  } catch {
    return undefined
  }
}

/**
 * A random key for this link in this tab, sent when starting a checkout: only a start with the same key gets
 * the payer's open checkout back, so someone who only knows their email can't. Kept for the tab's session
 * (a reload, "Change my details", the popup opened again); in memory when storage is blocked.
 */
const memoryKeys = new Map<string, string>()
function resumeKey(slug: string) {
  const name = `linkpay:resume:${slug}`
  try {
    const saved = window.sessionStorage.getItem(name)
    if (saved && /^[A-Za-z0-9_-]{16,64}$/.test(saved)) return saved
  } catch {}
  let key = memoryKeys.get(name)
  if (!key) {
    const bytes = crypto.getRandomValues(new Uint8Array(24))
    key = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
    memoryKeys.set(name, key)
  }
  try {
    window.sessionStorage.setItem(name, key)
  } catch {}
  return key
}

/** The payer's details from embed.js's `prefill` message, with the same limits as the query string. */
function prefillFromMessage(data: unknown): Pick<Prefill, "name" | "email" | "phone"> {
  const p = data && typeof data === "object" ? (data as Record<string, unknown>) : {}
  const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined)
  return { name: text(p.name, 100), email: text(p.email, 200), phone: text(p.phone, 20) }
}

const POLL_MS = 5_000
const SLOW_POLL_MS = 15_000
/** The backend gives 30 minutes to pay (`payWithinMinutes`); the time bar drains over that. */
const PAY_WINDOW_MS = 30 * 60_000
/** The backend keeps matching a checkout's amount for 2 hours from the start (30 minutes to pay + 90). */
const WATCH_AFTER_EXPIRY_MS = 90 * 60_000

export function PayClient({ data, logoSrc, initialCheckout, embed, frameId, prefill: initialPrefill }: Props) {
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

  // embed.js answers `ready` with the payer's details (never put in the frame's address). Only from the page
  // that holds this frame, for this frame, and from its origin when we know it.
  const [prefill, setPrefill] = useState(initialPrefill)
  useEffect(() => {
    if (!embed) return
    const parent = parentOrigin() ?? initialPrefill.origin
    target.current = parent ?? "*"
    const onMessage = (e: MessageEvent) => {
      if (e.source !== window.parent || (parent && e.origin !== parent)) return
      const d = e.data as { source?: unknown; type?: unknown; frameId?: unknown; prefill?: unknown } | null
      if (!d || d.source !== "linkpay" || d.type !== "prefill" || d.frameId !== frameId) return
      const sent = prefillFromMessage(d.prefill)
      setPrefill((prev) => ({ ...prev, name: sent.name ?? prev.name, email: sent.email ?? prev.email, phone: sent.phone ?? prev.phone }))
    }
    window.addEventListener("message", onMessage)
    post("ready", initialCheckout ? { checkout: summary(initialCheckout) } : {})
    return () => window.removeEventListener("message", onMessage)
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

  // Donation links: the live progress and donor list, and the report form (about the page or one donation).
  // Live updates from the link's stream: when the link changes (live or test, on or off, its details), reload
  // the page's data and the donor list; when a payment lands, pull in donations and re-check this payer's own
  // checkout now instead of at the next poll. Polling stays as the safety net, slower while the stream is open.
  const [streaming, setStreaming] = useState(false)
  const [nudge, setNudge] = useState(0)
  const feed = useDonationFeed(data.link.slug, data.donation, streaming)
  useLinkEvents(data.link.slug, {
    onLink: () => {
      router.refresh()
      feed?.reload()
      setNudge((n) => n + 1)
    },
    onPaid: () => {
      feed?.refresh()
      setNudge((n) => n + 1)
    },
    onConnected: setStreaming,
  })
  const [report, setReport] = useState<{ donation: PublicDonation | null } | null>(null)
  const refreshFeed = feed?.refresh

  const updated = useCallback(
    (c: PublicCheckout) => {
      if (lastStatus.current && lastStatus.current !== c.status) {
        post("update", { checkout: summary(c) })
        if (c.status === "paid") post("paid", { checkout: summary(c), redirectUrl: c.redirectUrl })
        // The payer's own donation landed: show it in the list and the total now.
        if (c.status === "paid") refreshFeed?.()
      }
      lastStatus.current = c.status
      setCheckout(c)
    },
    [post, refreshFeed],
  )

  // Fundraisers ask for the amount first, then the donor's details. The website may have set the amount already.
  const amountSet = !!(embed && prefill.amountKobo)
  const [onDetails, setOnDetails] = useState(amountSet)
  const formStage = (stage: "amount" | "details") => {
    setOnDetails(stage === "details")
    showSheetTop()
  }

  function startAgain() {
    lastStatus.current = undefined
    setCheckout(null)
    setUrlCheckout(null)
    setOnDetails(amountSet)
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
  // The checkout the card shows. A test checkout that isn't paid yet stops counting once the link goes live
  // (going live clears test payments), so the card starts over for a real one. Anything else carries on: a live
  // checkout can still be paid whatever the link does, and a paid one keeps its thank-you and reference.
  const inProgress = !!checkout && (checkout.status === "pending" || checkout.status === "expired")
  const current = inProgress && checkout!.mode === "test" && data.mode === "live" ? null : checkout
  const step: PayStep = !current ? (data.available ? 0 : -1) : current.status === "paid" ? 2 : 1
  const giftStep: GiftStep = step === 2 ? 3 : step === 1 ? 2 : onDetails ? 1 : 0
  // A transfer in progress keeps the mode it started in (its details are real or placeholders); otherwise the
  // strip follows the link as it is now, live updates included.
  const testMode = (current && inProgress ? current.mode : data.mode) === "test"

  // Keyed by step so each step makes its own entrance.
  const body = current ? (
    <CheckoutPanel
      key={`c-${current.status === "paid" ? "paid" : "open"}`}
      checkout={current}
      embed={embed}
      nudge={nudge}
      available={data.available}
      onUpdate={updated}
      onBack={startAgain}
    />
  ) : data.available ? (
    <PayForm key="form" data={data} embed={embed} prefill={prefill} onStarted={started} onStage={formStage} />
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
  const reportDialog = feed && report && (
    <ReportDialog
      key={report.donation?._id ?? "page"}
      slug={link.slug}
      businessName={business.name}
      donation={report.donation}
      open
      onOpenChange={(open) => !open && setReport(null)}
    />
  )

  if (embed) {
    const card = (
      <article style={vars} className="pay-brand surface overflow-hidden" aria-labelledby="pay-title">
        <header className="grain bg-(--biz) px-6 pt-6 pb-7 text-(--on-biz) sm:px-8">
          <LinkSummary
            {...summaryProps}
            variant="compact"
            price={feed && <FundraiserProgress progress={feed.progress} latest={feed.latest} variant="compact" />}
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
        {testMode && <TestModeStrip donation={!!feed} />}
        {feed ? (
          step >= 0 && <GiftSteps step={giftStep} className="px-6 pt-6 sm:px-8" />
        ) : (
          <StepTrack step={step} className="px-6 pt-6 sm:px-8" />
        )}
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

  if (feed) {
    return (
      <FundraiserPage
        vars={vars}
        slug={link.slug}
        businessName={business.name}
        logoSrc={logoSrc}
        title={link.title}
        story={link.description}
        images={images}
        feed={feed}
        sheetRef={sheet}
        sheet={
          <>
            {testMode && <TestModeStrip donation />}
            {step >= 0 && (
              <>
                {step < 2 && <TicketStub number={feed.progress.donationsCount + 1} />}
                <GiftSteps step={giftStep} className="px-6 pt-5 sm:px-7" />
              </>
            )}
            {body}
          </>
        }
        canGive={!current && data.available}
        onReport={(donation) => setReport({ donation })}
        reportDialog={reportDialog}
      />
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
              <StepTimeline step={step} dense={images.length > 0} test={testMode} />
              <Secured businessName={business.name} className="text-(--biz-muted)" />
            </div>
          )}
        </div>
      </aside>

      <div className="relative z-10 -mt-16 px-4 pb-10 sm:px-6 lg:mt-0 lg:flex lg:min-h-dvh lg:flex-col lg:items-center lg:justify-center lg:px-12 lg:py-10 short:py-4">
        <div className="mx-auto grid w-full max-w-120 gap-5">
          <section ref={sheet} aria-label="Payment" className="surface scroll-mt-4 overflow-hidden">
            {testMode && <TestModeStrip />}
            <StepTrack step={step} className="px-6 pt-6 sm:px-8 lg:hidden" />
            {body}
          </section>
          <Secured businessName={business.name} className={cn("text-center text-muted-foreground", step >= 0 && "lg:hidden")} />
        </div>
      </div>
    </main>
  )
}

/**
 * A fundraiser on its own page, as a ticket roll: what the money is for (title, pictures, total, story) on warm
 * paper, the roll of everyone who's given hanging from a spool in the business's colour, and the giving card.
 * Wide screens set the three side by side, with the roll and the card sticky; on a laptop the roll follows the
 * story; on a phone the card comes straight after the total, and a Donate bar waits while it's off screen.
 */
function FundraiserPage({
  vars,
  slug,
  businessName,
  logoSrc,
  title,
  story,
  images,
  feed,
  sheetRef,
  sheet,
  canGive,
  onReport,
  reportDialog,
}: {
  vars: React.CSSProperties
  slug: string
  businessName: string
  logoSrc: string | null
  title: string
  story: string | null
  images: { src: string; width: number; height: number }[]
  feed: NonNullable<ReturnType<typeof useDonationFeed>>
  sheetRef: React.RefObject<HTMLElement | null>
  sheet: React.ReactNode
  /** The form is showing (no checkout yet, and the link is taking donations). */
  canGive: boolean
  onReport: (donation: PublicDonation | null) => void
  reportDialog: React.ReactNode
}) {
  // The phone's Donate bar shows while the giving card is off screen.
  const [cardInView, setCardInView] = useState(true)
  useEffect(() => {
    const el = sheetRef.current
    if (!el) return
    const observer = new IntersectionObserver(([entry]) => setCardInView(entry.isIntersecting), { threshold: 0.15 })
    observer.observe(el)
    return () => observer.disconnect()
  }, [sheetRef])

  function goGive() {
    sheetRef.current?.scrollIntoView({ block: "start", behavior: "smooth" })
    // Focus without a second jump, once the scroll has started.
    setTimeout(() => sheetRef.current?.querySelector<HTMLElement>("[aria-pressed], #pay-amount, input")?.focus({ preventScroll: true }), 350)
  }

  const hasPictures = images.length > 0
  // The left column's rows (title, pictures and total, story), so the card spans exactly them and the roll starts below.
  const rows = 2 + (story ? 1 : 0)
  return (
    <main style={vars} className="pay-brand min-h-dvh bg-(--fund-ground) [--notch:var(--fund-ground)]">
      <div className="mx-auto grid w-full max-w-360 gap-y-8 px-4 pt-6 pb-28 sm:px-6 sm:pt-10 lg:px-10 lg:pb-16">
        {/* Its own grid, so the sticky card stops at the roll instead of riding over it. */}
        <div
          style={{ "--rows": rows } as React.CSSProperties}
          className="grid gap-x-10 gap-y-8 lg:grid-cols-[minmax(0,1fr)_24rem] xl:gap-x-12 2xl:grid-cols-[minmax(0,1fr)_25rem]"
        >
          <header className="page-enter grid gap-6 lg:col-start-1">
            <div className="flex items-center gap-3">
              <BusinessMark name={businessName} logoSrc={logoSrc} className="bg-(--biz) text-(--on-biz)" />
              <p className="grid min-w-0 flex-1 leading-snug">
                <span className="truncate text-[15px] font-medium">{businessName}</span>
                <span className="text-sm text-muted-foreground">is raising money</span>
              </p>
              <ShareButton title={title} className="rounded-full bg-transparent" />
            </div>
            <h1 id="pay-title" className="type-display text-[2.75rem] text-balance sm:text-6xl 2xl:text-[4rem]">
              {title}
            </h1>
          </header>

          {/* The pictures stay short, so the total and the story are on the first screen. Side by side once the column is wide enough. */}
          <div className="@container lg:col-start-1">
            <div className="grid gap-8 @3xl:grid-cols-2 @3xl:items-center @3xl:gap-10">
              {hasPictures && <FundraiserGallery images={images} title={title} />}
              <RaisedSummary progress={feed.progress} latest={feed.items[0] ?? null} />
            </div>
          </div>

          {story && (
            <section aria-labelledby="story-title" className="grid gap-3 lg:col-start-1">
              <h2 id="story-title" className="type-display text-2xl">
                About this fundraiser
              </h2>
              <p className="max-w-[65ch] text-[17px] leading-relaxed text-pretty whitespace-pre-line">{story}</p>
            </section>
          )}

          <aside className="lg:sticky lg:top-6 lg:col-start-2 lg:max-h-[calc(100dvh-3rem)] lg:self-start lg:overflow-y-auto lg:overscroll-contain lg:rounded-2xl lg:row-[1/span_var(--rows)]">
            <section ref={sheetRef} aria-label="Donate" className="surface scroll-mt-4 overflow-hidden">
              {sheet}
            </section>
            <Secured businessName={businessName} className="mt-4 px-2 text-center text-muted-foreground" />
          </aside>
        </div>

        {/* Everyone who's given, across the full width below the story and the card. */}
        <TicketRoll slug={slug} feed={feed} onReport={onReport} className="max-h-[min(48rem,85dvh)]" />

        <ReportLink onClick={() => onReport(null)} className="justify-self-start" />
      </div>
      <DonateBar progress={feed.progress} visible={canGive && !cardInView} onDonate={goGive} />
      {reportDialog}
    </main>
  )
}

/** Test mode (the business is trying the page out): says so on every step. */
function TestModeStrip({ donation = false }: { donation?: boolean }) {
  return (
    <p className="flex items-start gap-2.5 border-b border-dashed border-warning/50 bg-warning-subtle px-6 py-3 text-sm text-warning-foreground sm:px-8">
      <FlaskConical className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
      <span>
        <span className="font-semibold">Test mode.</span> No real money moves. The bank details are placeholders, and you can
        simulate the {donation ? "gift. Test gifts show on this page until it goes live." : "payment."}
      </span>
    </p>
  )
}

// ---------------------------------------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------------------------------------

function PayForm({
  data,
  embed,
  prefill,
  onStarted,
  onStage,
}: {
  data: PublicPaymentLink
  embed: EmbedMode
  prefill: Prefill
  onStarted: (c: PublicCheckout) => void
  /** Fundraisers: the form moved between the amount and the donor's details. */
  onStage?: (stage: "amount" | "details") => void
}) {
  const { link } = data
  const open = !link.amountKobo
  // The website set the amount (its cart total): shown, not editable.
  const lockedAmount = open && embed && prefill.amountKobo ? prefill.amountKobo : null
  const [name, setName] = useState(prefill.name ?? "")
  const [email, setEmail] = useState(prefill.email ?? "")
  const [phone, setPhone] = useState(prefill.phone ?? "")
  // embed.js's details arrive just after the form shows: fill in whatever the payer hasn't typed yet.
  const [shownPrefill, setShownPrefill] = useState(prefill)
  if (shownPrefill !== prefill) {
    setShownPrefill(prefill)
    if (!name && prefill.name) setName(prefill.name)
    if (!email && prefill.email) setEmail(prefill.email)
    if (!phone && prefill.phone) setPhone(prefill.phone)
  }
  const [amount, setAmount] = useState(prefill.amountKobo && open ? koboToInput(prefill.amountKobo).replace(/\.00$/, "") : "")
  const [fields, setFields] = useState<Record<string, string>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  // Donation links: the donor's choices for the public list.
  const donation = link.kind === "donation"
  const [anonymous, setAnonymous] = useState(false)
  const [message, setMessage] = useState("")
  const picks = data.donation?.suggestedAmountsKobo ?? []

  const min = link.minAmountKobo ?? 100_00
  const max = link.maxAmountKobo ?? 100_000_000_00
  // A fundraiser asks for the amount on its own first, so the donor decides before typing anything else.
  const [stage, setStage] = useState<"amount" | "details">(donation && !lockedAmount ? "amount" : "details")
  const go = (to: "amount" | "details") => {
    setStage(to)
    onStage?.(to)
  }
  const amountKobo = open ? (lockedAmount ?? parseNairaToKobo(amount) ?? undefined) : undefined
  const amountOk = !!amountKobo && amountKobo >= min && amountKobo <= max
  const amountError = `Enter an amount from ${formatNaira(min)} to ${formatNaira(max)}.`

  function toDetails(e: React.FormEvent) {
    e.preventDefault()
    if (!amountOk) return setErrors({ amountKobo: amountError })
    setErrors({})
    setError(undefined)
    go("details")
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const next: Record<string, string> = {}
    if (name.trim().length < 2) next.name = "Enter your name."
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) next.email = "Enter a valid email address, for your receipt."
    if (link.phone === "required" && !phone.trim()) next.phone = "Enter your phone number."
    if (phone.trim() && !/^\+?[0-9 ()-]{7,20}$/.test(phone.trim())) next.phone = "Enter a valid phone number."
    if (open && !amountOk) next.amountKobo = amountError
    for (const f of link.customFields) if (f.required && !fields[f._id]?.trim()) next[`fields.${f._id}`] = `Fill in "${f.label}".`
    if (message.length > MAX_MESSAGE) next.message = `Keep your message under ${MAX_MESSAGE} characters.`
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
      ...(donation && { anonymous, ...(message.trim() && { message: message.trim() }) }),
      ...(embed && {
        source: "embed",
        embedOrigin: parentOrigin(),
      }),
      resumeKey: resumeKey(link.slug),
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
    setError(payErrorMessage(json?.code, json?.error, json?.details?.reason))
    const field = json?.details?.field as string | undefined
    if (json?.code === "FIELD_REQUIRED" && field)
      setErrors({
        [field === "phone" ? "phone" : `fields.${field}`]: json.error,
      })
    if (json?.code === "INVALID_AMOUNT") {
      setErrors({ amountKobo: json.error })
      if (donation && !lockedAmount) go("amount")
    }
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

  const errorNote = error && (
    <p role="alert" className="flex gap-2 rounded-xl bg-destructive-subtle px-3.5 py-3 text-sm text-destructive">
      <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      {error}
    </p>
  )

  if (donation && stage === "amount") {
    return (
      <form onSubmit={toDetails} noValidate className="page-enter grid gap-5 px-6 pt-5 pb-7 sm:px-7 sm:pb-8">
        <div className="grid gap-1">
          <h2 className="type-display text-[1.75rem]">Add your gift</h2>
          <p className="text-sm text-muted-foreground">Paid by bank transfer, straight to {data.business.name}.</p>
        </div>
        {errorNote}
        {picks.length > 0 && (
          <div className="grid gap-2.5">
            <p id="gift-picks" className="text-sm font-medium">
              Choose an amount
            </p>
            <QuickPicks
              amounts={picks}
              labelledBy="gift-picks"
              selectedKobo={parseNairaToKobo(amount)}
              onPick={(kobo) => {
                setAmount(koboToInput(kobo).replace(/\.00$/, ""))
                setErrors({})
              }}
            />
          </div>
        )}
        <Field data-invalid={!!errors.amountKobo}>
          <FieldLabel htmlFor="pay-amount">{picks.length ? "Or enter your own" : "How much would you like to give?"}</FieldLabel>
          <NairaInput id="pay-amount" value={amount} invalid={!!errors.amountKobo} onChange={setAmount} />
          {errors.amountKobo ? (
            <FieldError>{errors.amountKobo}</FieldError>
          ) : (
            link.minAmountKobo &&
            link.minAmountKobo > 100_00 && <FieldDescription>At least {formatNaira(link.minAmountKobo)}.</FieldDescription>
          )}
        </Field>
        <Button type="submit" size="lg" className={cn(BIZ_BUTTON, "mt-1")}>
          {amountOk ? `Donate ${giftAmount(amountKobo!)}` : "Continue"}
          <ArrowRight data-icon="inline-end" aria-hidden />
        </Button>
      </form>
    )
  }

  return (
    <form onSubmit={submit} noValidate className="page-enter grid gap-5 px-6 pt-6 pb-7 sm:px-8 sm:pt-8 sm:pb-8 short:gap-3.5 short:pt-6 short:pb-6">
      {donation ? (
        // The donor's ticket fills in as they type: the amount they chose, their name (or Anonymous) and their words.
        <Ticket
          label="Your ticket"
          name={anonymous ? null : name.trim() || "Your name"}
          toneKey={(data.donation?.donationsCount ?? 0) + 1}
          amountKobo={amountKobo ?? 0}
          message={message.trim() || null}
          when="Once it lands"
          action={
            !lockedAmount && (
              <button
                type="button"
                onClick={() => go("amount")}
                className="-mr-2 rounded-full px-2.5 py-1 font-sans text-xs font-medium tracking-normal normal-case underline-offset-2 outline-none hover:bg-[color-mix(in_oklch,var(--tone-ink)_12%,transparent)] focus-visible:ring-2 focus-visible:ring-(--tone-ink)"
              >
                Change amount
              </button>
            )
          }
          className="rounded-[6px] transition-colors duration-300"
        />
      ) : (
        <div className="grid gap-1">
          <h2 className="type-display text-2xl">Your details</h2>
          <p className="text-sm text-muted-foreground">Next, we show you the account to send the money to.</p>
        </div>
      )}
      {errorNote}
      {open &&
        !donation &&
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
        {errors.email ? (
          <FieldError>{errors.email}</FieldError>
        ) : (
          <FieldDescription>
            {/* Simulated payments never email a receipt (the Paid screen says so too). */}
            {data.mode === "test" ? "Test payments on this page don't email a receipt." : <>We&apos;ll email your receipt here.</>}
          </FieldDescription>
        )}
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
      {donation && <DonorOptions anonymous={anonymous} message={message} onAnonymous={setAnonymous} onMessage={setMessage} error={errors.message} />}
      <Button type="submit" size="lg" disabled={busy} className={cn(BIZ_BUTTON, "mt-2")}>
        {busy ? <Spinner /> : <Landmark data-icon="inline-start" aria-hidden />}
        {donation ? `Donate ${amountKobo ? giftAmount(amountKobo) : ""} by bank transfer` : "Pay by bank transfer"}
      </Button>
    </form>
  )
}

/** "₦5,000" for whole amounts, "₦5,000.50" otherwise: the donor's own figure on the button. */
const giftAmount = (kobo: number) => (kobo % 100 ? formatNaira(kobo) : naira(kobo))

/** Copy for the payer, who has no LinkPay account: never mentions roles or the dashboard. */
function payErrorMessage(code?: string, fallback?: string, reason?: string) {
  switch (code) {
    case "PAYMENT_LINK_UNAVAILABLE":
      return "This link isn't taking payments right now."
    case "CHECKOUT_BUSY":
      return reason === "places_held"
        ? "The last places are being paid for right now. Try again in a few minutes."
        : "Lots of people are paying this amount right now. Try again in a few minutes."
    case "TOO_MANY_OPEN_CHECKOUTS":
      return "You've started several payments that are still waiting. Pay one of them, or try again later."
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
  const donation = data.link.kind === "donation"
  const what = donation ? "donations" : "payments"
  const text =
    reason === "taken_down"
      ? `This ${donation ? "fundraiser" : "link"} has been paused while LinkPay reviews it.`
      : reason === "expired"
        ? `This ${donation ? "fundraiser" : "link"} has ended and isn't taking ${what} any more.`
        : reason === "sold_out"
          ? `This link has reached its limit and isn't taking more ${what}.`
          : reason === "account_not_ready"
            ? `This business can't take ${what} yet. Try again later.`
            : `This ${donation ? "fundraiser" : "link"} isn't taking ${what} right now.`
  const Icon = reason === "expired" ? CalendarX2 : reason === "account_not_ready" ? Clock : CircleSlash
  return (
    <div className="page-enter grid gap-5 px-6 py-8 sm:px-8 sm:py-10">
      <span className="grid size-12 place-items-center rounded-[30%] bg-muted text-muted-foreground">
        <Icon className="size-6" aria-hidden />
      </span>
      <div className="grid gap-1.5">
        <h2 className="type-display text-2xl">Not taking {what}</h2>
        <p className="text-[15px] leading-relaxed text-muted-foreground">
          {text} {reason === "taken_down" ? "" : `Contact ${data.business.name} if you need to pay them.`}
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
  nudge,
  available,
  onUpdate,
  onBack,
}: {
  checkout: PublicCheckout
  embed: EmbedMode
  /** Goes up when the link's live stream says a payment landed: check this checkout now. */
  nudge: number
  /** Whether the link takes payments right now (kept live by the stream). */
  available: boolean
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

  // A payment landed on the link (live stream): it may be this one, so look now.
  useEffect(() => {
    if (!nudge || !waiting) return
    let stopped = false
    fetch(`/api/pay/checkouts/${encodeURIComponent(c.token)}`, { cache: "no-store" })
      .then((res) => (res.ok ? (res.json() as Promise<PublicCheckout>) : null))
      .then((next) => next && !stopped && onUpdate(next))
      .catch(() => {})
    return () => {
      stopped = true
    }
  }, [nudge, waiting, c.token, onUpdate])

  if (c.status === "paid") return <Paid checkout={c} embed={embed} available={available} onAgain={onBack} />
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

      {c.mode === "test" && c.payTo && <SimulateTransfer checkout={c} onUpdate={onUpdate} />}

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

/** Test checkouts: pay as if the transfer had arrived, so the business sees the paid screen, receipt and its website's callbacks. */
function SimulateTransfer({ checkout: c, onUpdate }: { checkout: PublicCheckout; onUpdate: (c: PublicCheckout) => void }) {
  const [busy, setBusy] = useState<"paid" | "underpaid" | null>(null)
  const [error, setError] = useState<string>()
  const donation = c.link.kind === "donation"

  async function simulate(outcome: "paid" | "underpaid") {
    setBusy(outcome)
    setError(undefined)
    try {
      const res = await fetch(`/api/pay/checkouts/${encodeURIComponent(c.token)}/simulate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outcome }),
      })
      const json = await res.json().catch(() => null)
      if (res.ok && json) return onUpdate(json as PublicCheckout)
      setError(json?.code === "CHECKOUT_NOT_PENDING" ? "This test payment has already been made." : (json?.error ?? "That didn't work. Try again."))
    } catch {
      setError("We couldn't reach LinkPay. Check your connection and try again.")
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="grid gap-3 border-t border-dashed px-6 py-5 sm:px-8 short:py-4">
      <p className="text-sm leading-relaxed text-pretty text-muted-foreground">
        {donation
          ? "Don't send money to these details. Simulate the gift to see it land: it prints on the roll and counts in the total until the fundraiser goes live."
          : "Don't send money to these details. Simulate the transfer to see what your customers see once theirs lands."}
      </p>
      {error && (
        <p role="alert" className="flex gap-2 rounded-xl bg-destructive-subtle px-3.5 py-3 text-sm text-destructive">
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          {error}
        </p>
      )}
      <div className={cn("grid gap-2", !donation && "sm:grid-cols-[minmax(0,1fr)_auto]")}>
        <Button type="button" size="lg" disabled={!!busy} onClick={() => simulate("paid")} className={BIZ_BUTTON}>
          {busy === "paid" ? <Spinner /> : <FlaskConical data-icon="inline-start" aria-hidden />}
          {donation ? "Simulate the gift" : "Simulate payment"}
        </Button>
        {/* Any amount that arrives is a whole gift, so a fundraiser has no part payment to try. */}
        {!donation && (
          <Button type="button" size="lg" variant="outline" disabled={!!busy} onClick={() => simulate("underpaid")} className="h-12 text-[15px]">
            {busy === "underpaid" && <Spinner />}
            Simulate part payment
          </Button>
        )}
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
          {c.mode === "test"
            ? "A simulated part payment of half the price. This is what a customer sees if they send too little."
            : `${c.business.name} received part of the price. Contact them about the rest, quoting the reference below.`}
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

function Paid({
  checkout: c,
  embed,
  available,
  onAgain,
}: {
  checkout: PublicCheckout
  embed: EmbedMode
  /** The link takes payments right now: offer another go. */
  available: boolean
  onAgain: () => void
}) {
  // On its own page, a link with a redirect sends the payer on after a moment.
  useEffect(() => {
    if (embed || !c.redirectUrl) return
    const id = setTimeout(() => window.location.assign(c.redirectUrl!), 5000)
    return () => clearTimeout(id)
  }, [embed, c.redirectUrl])

  const donation = c.link.kind === "donation"
  const rows: [string, React.ReactNode][] = [
    [
      donation ? "You gave" : "Amount paid",
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
        <h2 className="type-display text-[2rem]">
          {c.mode === "test" ? (donation ? "Test donation received" : "Test payment received") : donation ? "Thank you for giving" : "Payment received"}
        </h2>
        <p className="text-[15px] leading-relaxed text-muted-foreground">
          {c.mode === "test" ? (
            <>
              No money was sent.{" "}
              {donation ? "Your test gift is on the roll and in the total until the fundraiser goes live. " : ""}
              Test payments made on this page don&apos;t email a receipt.
            </>
          ) : donation ? (
            <>
              {c.business.name} has your donation. It shows on this page{" "}
              {c.donor?.anonymous ? "as Anonymous" : <>under your name, {c.payer.name}</>}. We&apos;ve emailed a receipt to{" "}
              <span className="text-foreground">{c.payer.email}</span>.
            </>
          ) : (
            <>
              {c.business.name} has your payment. We&apos;ve emailed a receipt to <span className="text-foreground">{c.payer.email}</span>.
            </>
          )}
        </p>
      </div>
      {donation && (
        <Ticket
          label="Your ticket"
          flag={c.mode === "test" ? "Test gift" : "On the roll"}
          test={c.mode === "test"}
          name={c.donor?.anonymous ? null : c.payer.name}
          toneKey={c.donor?.anonymous ? "anonymous" : c.payer.name}
          amountKobo={c.paidKobo ?? c.amountKobo}
          message={c.donor?.message ?? null}
          when="Just now"
          className="ticket-print rounded-[6px]"
        />
      )}
      {c.successMessage && (
        <figure className="grid gap-1 rounded-xl bg-(--biz-soft) px-4 py-3.5">
          <figcaption className="text-xs text-muted-foreground">From {c.business.name}</figcaption>
          <p className="text-[15px] leading-relaxed whitespace-pre-line">{c.successMessage}</p>
        </figure>
      )}
      <Receipt rows={rows} />
      {donation && !c.redirectUrl && (
        <div className="grid gap-2">
          <p className="text-sm text-muted-foreground">Share it with people who&apos;d want to help.</p>
          <ShareButton title={c.link.title} size="lg" className="h-12 w-full text-[15px]" />
        </div>
      )}
      {!c.redirectUrl &&
        (available ? (
          <Button type="button" variant="outline" size="lg" onClick={onAgain} className="h-12 w-full text-[15px]">
            <RotateCcw data-icon="inline-start" aria-hidden />
            {donation ? "Give again" : "Make another payment"}
          </Button>
        ) : (
          <p className="text-sm text-muted-foreground">
            {donation ? "This fundraiser isn't taking donations right now." : "This link isn't taking payments right now."}
          </p>
        ))}
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
