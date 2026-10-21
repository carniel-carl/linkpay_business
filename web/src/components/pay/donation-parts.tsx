"use client"

import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { AnimatePresence, animate, motion, useMotionValue, useReducedMotion, useTransform } from "motion/react"
import { Check, CircleAlert, Flag, Heart, MoreHorizontal, Share2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import type { DonationProgress, DonationSort, PublicDonation, PublicDonationFeed, PublicDonationPage, PublicPaymentLink } from "@/lib/api/types"
import { timeAgo } from "@/lib/format"
import { cn } from "@/lib/utils"
import { BIZ_BUTTON, type SummaryImage } from "./pay-parts"

// Donation links (fundraisers) on the pay page: what's been raised, the donors and the report form.
// Contract: docs/briefs/donations.md §3.

/** How often the page looks for new donations while it's on screen. */
const FEED_POLL_MS = 15_000
/** How long a new donation stays highlighted in the list. */
const FRESH_MS = 6_000
const PAGE_SIZE = 20
/** Same as the backend's DONATION_LIMITS.maxMessageLength. */
export const MAX_MESSAGE = 280

/** "₦1,250,000": whole naira, for raised and goal figures. */
export const naira = (kobo: number) => `₦${Math.floor(kobo / 100).toLocaleString("en-NG")}`

type Donation = NonNullable<PublicPaymentLink["donation"]>

// ---------------------------------------------------------------------------------------------------------
// The live feed: progress and the newest donors, kept fresh by polling
// ---------------------------------------------------------------------------------------------------------

export type DonationFeed = {
  progress: DonationProgress
  /** Newest first. */
  items: PublicDonation[]
  /** Donations that arrived since the page opened, highlighted for a few seconds. */
  fresh: Set<string>
  /** The newest arrival, for the "just in" chip. */
  latest: PublicDonation | null
  hasMore: boolean
  loadingMore: boolean
  loadMore: () => void
  /** Look now (after the payer's own donation lands). */
  refresh: () => void
}

const NO_DONATIONS: Donation = {
  goalKobo: null,
  raisedKobo: 0,
  donationsCount: 0,
  percent: null,
  lastDonationAt: null,
  suggestedAmountsKobo: [],
  recent: { items: [], nextBefore: null },
}

/** The fundraiser's live figures and donors. `initial` null (a payment link): nothing is fetched and the feed is null. */
export function useDonationFeed(slug: string, initial: Donation | null): DonationFeed | null {
  const enabled = !!initial
  const start = initial ?? NO_DONATIONS
  const [progress, setProgress] = useState<DonationProgress>(start)
  const [items, setItems] = useState(start.recent.items)
  const [nextBefore, setNextBefore] = useState(start.recent.nextBefore)
  const [fresh, setFresh] = useState<Set<string>>(() => new Set())
  const [latest, setLatest] = useState<PublicDonation | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  const fetchPage = useCallback(
    async (query: Record<string, string>) => {
      const res = await fetch(`/api/pay/${encodeURIComponent(slug)}/donations?${new URLSearchParams(query)}`, { cache: "no-store" })
      if (!res.ok) throw new Error(String(res.status))
      return (await res.json()) as PublicDonationFeed
    },
    [slug],
  )

  const refresh = useCallback(async () => {
    let page: PublicDonationFeed
    try {
      page = await fetchPage({ take: String(PAGE_SIZE) })
    } catch {
      return
    }
    setProgress(page.progress)
    setItems((current) => {
      const known = new Set(current.map((d) => d._id))
      const newest = current[0]?.paidAt ?? ""
      // Only donations newer than what's shown are arrivals; older unseen ones come with paging.
      const arrived = page.items.filter((d) => !known.has(d._id) && (d.paidAt ?? "") >= newest)
      if (!arrived.length) return current
      const arrival = arrived[0]
      setLatest(arrival)
      setTimeout(() => setLatest((l) => (l?._id === arrival._id ? null : l)), FRESH_MS)
      setFresh((prev) => new Set([...prev, ...arrived.map((d) => d._id)]))
      for (const d of arrived) {
        timers.current.set(
          d._id,
          setTimeout(() => {
            timers.current.delete(d._id)
            setFresh((prev) => {
              const next = new Set(prev)
              next.delete(d._id)
              return next
            })
          }, FRESH_MS),
        )
      }
      return [...arrived, ...current]
    })
  }, [fetchPage])

  // Poll while the tab is visible, and look straight away when it comes back.
  useEffect(() => {
    if (!enabled) return
    const tick = () => document.visibilityState === "visible" && void refresh()
    const id = setInterval(tick, FEED_POLL_MS)
    document.addEventListener("visibilitychange", tick)
    const pending = timers.current
    return () => {
      clearInterval(id)
      document.removeEventListener("visibilitychange", tick)
      pending.forEach(clearTimeout)
    }
  }, [enabled, refresh])

  const loadMore = useCallback(async () => {
    if (!nextBefore || loadingMore) return
    setLoadingMore(true)
    try {
      const page = await fetchPage({ take: String(PAGE_SIZE), before: nextBefore })
      setItems((current) => {
        const known = new Set(current.map((d) => d._id))
        return [...current, ...page.items.filter((d) => !known.has(d._id))]
      })
      setNextBefore(page.nextBefore)
    } catch {
    } finally {
      setLoadingMore(false)
    }
  }, [fetchPage, loadingMore, nextBefore])

  const refreshNow = useCallback(() => void refresh(), [refresh])

  if (!enabled) return null
  return { progress, items, fresh, latest, hasMore: !!nextBefore, loadingMore, loadMore, refresh: refreshNow }
}

// ---------------------------------------------------------------------------------------------------------
// Progress: raised, goal, bar
// ---------------------------------------------------------------------------------------------------------

/** A naira figure that counts up to its value (from zero on first show, then from the last value). */
export function CountUp({ kobo, className }: { kobo: number; className?: string }) {
  const reduce = useReducedMotion()
  const value = useMotionValue(reduce ? kobo : 0)
  const text = useTransform(value, (v) => naira(v))
  useEffect(() => {
    if (reduce) {
      value.set(kobo)
      return
    }
    const controls = animate(value, kobo, { duration: 1.4, ease: [0.16, 1, 0.3, 1] })
    return () => controls.stop()
  }, [kobo, reduce, value])
  return (
    <span className={cn("figure", className)}>
      <span aria-hidden>
        <motion.span>{text}</motion.span>
      </span>
      <span className="sr-only">{naira(kobo)}</span>
    </span>
  )
}

/**
 * Raised of the goal with an animated bar, on the business's colour (the panel or the embed's header).
 * The bar grows in on first show and again whenever a donation lands, with a sheen across it.
 */
export function FundraiserProgress({
  progress,
  latest,
  variant = "panel",
  className,
}: {
  progress: DonationProgress
  latest?: PublicDonation | null
  variant?: "panel" | "compact"
  className?: string
}) {
  const reduce = useReducedMotion()
  const { goalKobo, raisedKobo, donationsCount, percent } = progress
  const shown = goalKobo ? Math.min(100, Math.max(raisedKobo > 0 ? 1.5 : 0, (raisedKobo / goalKobo) * 100)) : 0
  const reached = goalKobo !== null && raisedKobo >= goalKobo
  const compact = variant === "compact"
  return (
    <div className={cn("grid gap-3", className)}>
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <p className={cn("type-display leading-none", compact ? "text-[2rem]" : "text-[2.75rem] sm:text-6xl short:text-5xl")}>
          <CountUp kobo={raisedKobo} />
        </p>
        <p className={cn("text-(--biz-muted)", compact ? "text-sm" : "text-[15px]")}>
          {goalKobo ? (
            <>
              raised of <span className="figure font-medium text-(--on-biz)">{naira(goalKobo)}</span>
            </>
          ) : (
            "raised"
          )}
        </p>
      </div>

      {goalKobo !== null && (
        <div
          role="progressbar"
          aria-label="Raised towards the goal"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.min(100, percent ?? 0)}
          className={cn("relative overflow-hidden rounded-full bg-(--biz-line)", compact ? "h-2" : "h-3")}
        >
          <motion.div
            initial={{ width: reduce ? `${shown}%` : "0%" }}
            animate={{ width: `${shown}%` }}
            transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 55, damping: 18, mass: 1.1, delay: 0.15 }}
            className="relative h-full overflow-hidden rounded-full bg-(--on-biz)"
          >
            {/* A sheen runs along the bar each time a donation lands (keyed on the newest one). */}
            {!reduce && <span key={latest?._id ?? "first"} aria-hidden className="donation-sheen absolute inset-y-0 -left-1/2 w-1/2" />}
          </motion.div>
        </div>
      )}

      <p className={cn("flex flex-wrap gap-x-3 gap-y-1 text-(--biz-muted)", compact ? "text-xs" : "text-sm")}>
        <span>
          <span className="figure font-medium text-(--on-biz)">{donationsCount.toLocaleString("en-NG")}</span>{" "}
          {donationsCount === 1 ? "donation" : "donations"}
        </span>
        {percent !== null && (
          <span>
            {reached ? (
              <span className="font-medium text-(--on-biz)">Goal reached</span>
            ) : (
              <>
                <span className="figure font-medium text-(--on-biz)">{percent}%</span> of the goal
              </>
            )}
          </span>
        )}
        {progress.lastDonationAt && <span>Last one {timeAgo(progress.lastDonationAt)}</span>}
      </p>
      {/* The newest arrival, briefly. The row keeps its height so nothing jumps. */}
      {!compact && (
        <div aria-live="polite" className="h-7">
          <AnimatePresence mode="popLayout">
            {latest && (
              <motion.span
                key={latest._id}
                initial={reduce ? { opacity: 0 } : { opacity: 0, y: 10, scale: 0.92 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={reduce ? { opacity: 0 } : { opacity: 0, y: -8 }}
                transition={{ type: "spring", stiffness: 420, damping: 30 }}
                className="inline-flex items-center gap-1.5 rounded-full bg-(--on-biz) px-3 py-1 text-xs font-medium text-(--biz) shadow-[0_8px_20px_-10px_oklch(0.15_0.03_252/0.6)]"
              >
                <Heart className="size-3 fill-current" aria-hidden />
                {naira(latest.amountKobo)} from {latest.name ?? "someone anonymous"}
              </motion.span>
            )}
          </AnimatePresence>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------------
// Tickets: every gift is a numbered ticket in its donor's colour
// ---------------------------------------------------------------------------------------------------------

const TONES = ["amber", "sky", "coral", "green", "violet", "rose"] as const

/**
 * A ticket's colour (`--tone`, `--tone-ink`). A number is the ticket's place on the roll, so neighbours never
 * match and the donor's stub previews the colour their ticket prints in; a string (a name) always gives the same one.
 */
export function donorTone(key: string | number) {
  let index = typeof key === "number" ? key : 0
  if (typeof key === "string") for (const ch of key) index = (index * 31 + ch.charCodeAt(0)) >>> 0
  const tone = TONES[Math.abs(index) % TONES.length]
  return { "--tone": `var(--donor-${tone})`, "--tone-ink": `var(--donor-${tone}-ink)` } as CSSProperties
}

/** "No. 0120". */
export const ticketNumber = (n: number) => `No. ${String(Math.max(n, 0)).padStart(4, "0")}`

/**
 * One gift as a ticket off the roll: its number, the amount at display size, who and when, and their words.
 * The notches at the top are the ground showing through the perforation (`--ticket-ground`, the roll's paper
 * by default). `perforated` draws the tear line along the top, between it and the ticket above.
 */
export function Ticket({
  label,
  amountKobo,
  name,
  message,
  when,
  flag,
  action,
  toneKey,
  perforated = false,
  className,
}: {
  /** The ticket number, or "Your ticket". */
  label: string
  amountKobo: number | null
  /** null: anonymous. */
  name: string | null
  message: string | null
  when: ReactNode
  /** "Just in", "Top gift": printed opposite the number. */
  flag?: string
  /** The ⋯ menu. */
  action?: ReactNode
  toneKey: string | number
  perforated?: boolean
  className?: string
}) {
  return (
    <div style={donorTone(toneKey)} className={cn("relative grid gap-2.5 bg-(--tone) px-6 pt-4 pb-5 text-(--tone-ink)", className)}>
      {perforated && (
        <>
          <span aria-hidden className="absolute inset-x-3 top-0 border-t-2 border-dashed border-[var(--ticket-ground,var(--fund-ground))]" />
          <span aria-hidden className="absolute top-0 -left-2.5 size-5 -translate-y-1/2 rounded-full bg-[var(--ticket-ground,var(--fund-ground))]" />
          <span aria-hidden className="absolute top-0 -right-2.5 size-5 -translate-y-1/2 rounded-full bg-[var(--ticket-ground,var(--fund-ground))]" />
        </>
      )}
      <div className="flex min-h-8 items-center justify-between gap-3 font-mono text-xs tracking-[0.06em] uppercase">
        <span className="opacity-80">{label}</span>
        <span className="flex items-center gap-1">
          {flag && <span className="font-medium">{flag}</span>}
          {action}
        </span>
      </div>
      {amountKobo !== null && (
        <p className="type-display text-[2.375rem] leading-none">
          <span className="figure">{naira(amountKobo)}</span>
        </p>
      )}
      <div className="flex items-baseline justify-between gap-3">
        <span className="flex min-w-0 items-center gap-1.5 text-[15px] font-medium">
          {!name && <Heart className="size-3.5 shrink-0 fill-current" aria-hidden />}
          <span className="truncate">{name ?? "Anonymous"}</span>
        </span>
        <span className="shrink-0 text-xs opacity-80">{when}</span>
      </div>
      {message && <p className="text-[15px] leading-snug text-pretty wrap-break-word">&ldquo;{message}&rdquo;</p>}
    </div>
  )
}

/** The top of the giving card: the donor's own ticket stub, with the number their gift will take. */
export function TicketStub({ number, className }: { number: number; className?: string }) {
  return (
    <div className={cn("relative flex items-center justify-between gap-3 px-6 pt-5 pb-4 font-mono text-xs tracking-[0.06em] uppercase sm:px-7", className)}>
      <span className="text-muted-foreground">Your ticket</span>
      <span>{ticketNumber(number)}</span>
      <span aria-hidden className="absolute inset-x-4 bottom-0 border-t-2 border-dashed border-border" />
      <span aria-hidden className="absolute bottom-0 -left-2.5 size-5 translate-y-1/2 rounded-full bg-(--fund-ground)" />
      <span aria-hidden className="absolute -right-2.5 bottom-0 size-5 translate-y-1/2 rounded-full bg-(--fund-ground)" />
    </div>
  )
}

/** Raised of the goal on the paper: the figure counts up, the bar springs in and sheens when a gift lands. */
export function RaisedSummary({ progress, latest, className }: { progress: DonationProgress; latest: PublicDonation | null; className?: string }) {
  const reduce = useReducedMotion()
  const { goalKobo, raisedKobo, donationsCount, percent } = progress
  const shown = goalKobo ? Math.min(100, Math.max(raisedKobo > 0 ? 1.5 : 0, (raisedKobo / goalKobo) * 100)) : 0
  const reached = goalKobo !== null && raisedKobo >= goalKobo
  return (
    <section aria-label="Raised so far" className={cn("grid gap-4", className)}>
      <div className="grid gap-2.5">
        <p className="type-display text-[3.5rem] leading-[0.92] sm:text-[4.5rem]">
          <CountUp kobo={raisedKobo} />
        </p>
        <p className="text-[17px] text-muted-foreground">
          {goalKobo ? (
            <>
              raised of a <span className="figure font-medium text-foreground">{naira(goalKobo)}</span> goal
            </>
          ) : (
            "raised so far"
          )}
        </p>
      </div>
      {goalKobo !== null && (
        <div
          role="progressbar"
          aria-label="Raised towards the goal"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.min(100, percent ?? 0)}
          className="relative h-3.5 overflow-hidden rounded-full bg-[color-mix(in_oklch,var(--foreground)_10%,transparent)]"
        >
          <motion.div
            initial={{ width: reduce ? `${shown}%` : "0%" }}
            animate={{ width: `${shown}%` }}
            transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 55, damping: 18, mass: 1.1, delay: 0.15 }}
            className="relative h-full overflow-hidden rounded-full bg-(--biz-strong)"
          >
            {!reduce && <span key={latest?._id ?? "first"} aria-hidden className="donation-sheen absolute inset-y-0 -left-1/2 w-1/2" />}
          </motion.div>
        </div>
      )}
      <p className="flex flex-wrap gap-x-5 gap-y-1 text-[15px] text-muted-foreground">
        <span>
          <span className="figure font-semibold text-foreground">{donationsCount.toLocaleString("en-NG")}</span>{" "}
          {donationsCount === 1 ? "ticket" : "tickets"} so far
        </span>
        {percent !== null &&
          (reached ? (
            <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
              <Check className="size-4" strokeWidth={3} aria-hidden />
              Goal reached, still taking gifts
            </span>
          ) : (
            <span>
              <span className="figure font-semibold text-foreground">{percent}%</span> of the goal
            </span>
          ))}
      </p>
    </section>
  )
}

/** What the money is for: the pictures at their own shape on a soft fill of themselves, with thumbnails to switch. */
export function FundraiserGallery({ images, title, className }: { images: SummaryImage[]; title: string; className?: string }) {
  const [index, setIndex] = useState(0)
  const shown = images[Math.min(index, images.length - 1)]
  return (
    <figure className={cn("flex flex-col gap-2.5", className)}>
      <div className="relative h-[min(26rem,52vw)] overflow-hidden rounded-[18px] bg-muted lg:h-[min(26rem,44vh)]">
        {/* A blurred copy fills the frame, so a tall poster or a wide photo both keep their shape. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={shown.src} alt="" aria-hidden className="absolute inset-0 size-full scale-125 object-cover blur-2xl saturate-150" />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          key={shown.src}
          src={shown.src}
          alt={images.length > 1 ? `${title}, picture ${index + 1} of ${images.length}` : title}
          width={shown.width}
          height={shown.height}
          className="page-enter absolute inset-0 size-full object-contain drop-shadow-[0_12px_24px_oklch(0.15_0.03_252/0.35)]"
        />
      </div>
      {images.length > 1 && (
        <div role="group" aria-label="Pictures" className="flex gap-2">
          {images.map((img, i) => (
            <button
              key={img.src}
              type="button"
              aria-pressed={i === index}
              aria-label={`Show picture ${i + 1}`}
              onClick={() => setIndex(i)}
              className={cn(
                "size-14 overflow-hidden rounded-[10px] ring-2 ring-offset-2 ring-offset-(--fund-ground) transition-[opacity,box-shadow] duration-150 outline-none focus-visible:ring-ring",
                i === index ? "ring-(--biz-strong)" : "opacity-65 ring-transparent hover:opacity-100",
              )}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={img.src} alt="" className="size-full object-cover" />
            </button>
          ))}
        </div>
      )}
    </figure>
  )
}

// ---------------------------------------------------------------------------------------------------------
// Giving: amount, then details, then the transfer
// ---------------------------------------------------------------------------------------------------------

/** Quick-pick amounts, big enough to tap without aiming. */
export function QuickPicks({
  amounts,
  selectedKobo,
  onPick,
  labelledBy,
}: {
  amounts: number[]
  selectedKobo: number | null
  onPick: (kobo: number) => void
  labelledBy?: string
}) {
  if (!amounts.length) return null
  return (
    <div role="group" aria-labelledby={labelledBy} aria-label={labelledBy ? undefined : "Suggested amounts"} className="grid grid-cols-2 gap-2.5">
      {amounts.map((kobo) => {
        const on = selectedKobo === kobo
        return (
          <button
            key={kobo}
            type="button"
            aria-pressed={on}
            onClick={() => onPick(kobo)}
            className={cn(
              "h-14 rounded-xl border font-display text-xl font-semibold tracking-[-0.02em] transition-[background-color,border-color,color,transform] duration-150 outline-none focus-visible:ring-3 focus-visible:ring-ring/50 active:scale-[0.98]",
              on ? "border-transparent bg-(--biz) text-(--on-biz)" : "border-input bg-card hover:border-(--biz-strong) hover:bg-(--biz-soft)",
            )}
          >
            <span className="figure">{naira(kobo)}</span>
          </button>
        )
      })}
    </div>
  )
}

const GIFT_STEPS = ["Amount", "Your details", "Transfer"] as const

/** Where the donor is: 0 amount, 1 details, 2 transfer, 3 landed. */
export type GiftStep = 0 | 1 | 2 | 3

/** Three short bars over the giving card. */
export function GiftSteps({ step, className }: { step: GiftStep; className?: string }) {
  return (
    <ol aria-label="Progress" className={cn("grid grid-cols-3 gap-2", className)}>
      {GIFT_STEPS.map((label, i) => {
        const state = i < step ? "done" : i === step ? "current" : "next"
        return (
          <li key={label} aria-current={state === "current" ? "step" : undefined} className="grid gap-1.5">
            <span aria-hidden className={cn("h-1 rounded-full transition-colors duration-500", state === "next" ? "bg-border" : "bg-(--biz-strong)")} />
            <span className={cn("text-xs", state === "current" ? "font-medium text-foreground" : "text-muted-foreground")}>
              {label}
              <span className="sr-only">, {state === "done" ? "done" : state === "current" ? "current step" : "to come"}</span>
            </span>
          </li>
        )
      })}
    </ol>
  )
}

/** "Don't show my name" and words of support. */
export function DonorOptions({
  anonymous,
  message,
  onAnonymous,
  onMessage,
  error,
}: {
  anonymous: boolean
  message: string
  onAnonymous: (v: boolean) => void
  onMessage: (v: string) => void
  error?: string
}) {
  return (
    <>
      <Field data-invalid={!!error}>
        <FieldLabel htmlFor="pay-message">Words of support (optional)</FieldLabel>
        <Textarea
          id="pay-message"
          rows={3}
          maxLength={MAX_MESSAGE}
          value={message}
          aria-invalid={!!error}
          onChange={(e) => onMessage(e.target.value)}
          placeholder="Say why you're giving"
          className="min-h-20 resize-none"
        />
        {error ? (
          <FieldError>{error}</FieldError>
        ) : (
          <FieldDescription>
            Shown with your donation. <span className="figure">{MAX_MESSAGE - message.length}</span> characters left.
          </FieldDescription>
        )}
      </Field>
      <Label
        htmlFor="pay-anonymous"
        className="flex cursor-pointer items-start gap-3 rounded-xl border px-4 py-3 font-normal transition-colors hover:bg-muted/40 has-data-[state=checked]:border-(--biz-strong) has-data-[state=checked]:bg-(--biz-soft)"
      >
        <Checkbox id="pay-anonymous" checked={anonymous} onCheckedChange={(v) => onAnonymous(v === true)} className="mt-0.5" />
        <span className="grid gap-0.5">
          <span className="text-[15px] font-medium">Don&apos;t show my name</span>
          <span className="text-sm leading-snug text-muted-foreground">You&apos;ll show as Anonymous. The organiser still sees who gave.</span>
        </span>
      </Label>
    </>
  )
}

/** Share the fundraiser: the phone's share sheet where there is one, otherwise copy the link. */
export function ShareButton({ title, className, size = "default" }: { title: string; className?: string; size?: "default" | "lg" }) {
  async function share() {
    const url = `${window.location.origin}${window.location.pathname}`
    if (navigator.share) {
      try {
        await navigator.share({ title, url })
        return
      } catch (e) {
        if ((e as Error).name === "AbortError") return
      }
    }
    try {
      await navigator.clipboard.writeText(url)
      toast.success("Link copied. Paste it anywhere to share.")
    } catch {
      toast.error("We couldn't copy the link. Copy it from the address bar.")
    }
  }
  return (
    <Button type="button" variant="outline" size={size} onClick={share} className={className}>
      <Share2 data-icon="inline-start" aria-hidden />
      Share
    </Button>
  )
}

/** On a phone, a Donate bar along the bottom while the giving card is off screen. */
export function DonateBar({ progress, visible, onDonate }: { progress: DonationProgress; visible: boolean; onDonate: () => void }) {
  const { goalKobo, raisedKobo } = progress
  const shown = goalKobo ? Math.min(100, (raisedKobo / goalKobo) * 100) : 0
  return (
    <div
      inert={!visible}
      className={cn(
        "fixed inset-x-0 bottom-0 z-header border-t bg-card px-4 pt-3 pb-[max(env(safe-area-inset-bottom),0.75rem)] shadow-[0_-12px_32px_-20px_oklch(0.3_0.04_252/0.45)] transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none lg:hidden",
        visible ? "translate-y-0" : "translate-y-full",
      )}
    >
      <div className="mx-auto flex max-w-xl items-center gap-4">
        <div className="grid min-w-0 flex-1 gap-1.5">
          <p className="truncate text-sm">
            <span className="figure font-semibold">{naira(raisedKobo)}</span>{" "}
            <span className="text-muted-foreground">raised{goalKobo ? ` of ${naira(goalKobo)}` : ""}</span>
          </p>
          {goalKobo !== null && (
            <div aria-hidden className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-(--biz-strong)" style={{ width: `${shown}%` }} />
            </div>
          )}
        </div>
        <Button type="button" onClick={onDonate} className={cn(BIZ_BUTTON, "h-11 w-auto px-6")}>
          <Heart data-icon="inline-start" className="fill-current" aria-hidden />
          Donate
        </Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------------
// The roll (virtualized): everyone who's given, as tickets
// ---------------------------------------------------------------------------------------------------------

const ROW_ESTIMATE = 150
const PREFETCH_ROWS = 6

/** "Top" donors: fetched when the toggle is first used (`open`), then paged. */
function useTopDonations(slug: string) {
  const [state, setState] = useState<{ items: PublicDonation[]; nextBefore: string | null; loaded: boolean }>({ items: [], nextBefore: null, loaded: false })
  const [loading, setLoading] = useState(false)
  const load = useCallback(
    async (before?: string) => {
      setLoading(true)
      try {
        const query = new URLSearchParams({ sort: "top" satisfies DonationSort, take: String(PAGE_SIZE), ...(before && { before }) })
        const res = await fetch(`/api/pay/${encodeURIComponent(slug)}/donations?${query}`, { cache: "no-store" })
        if (res.ok) {
          const page = (await res.json()) as PublicDonationPage
          setState((s) => ({ items: before ? [...s.items, ...page.items] : page.items, nextBefore: page.nextBefore, loaded: true }))
        }
      } catch {
      } finally {
        setLoading(false)
      }
    },
    [slug],
  )
  return {
    ...state,
    loading,
    open: () => !state.loaded && !loading && void load(),
    loadMore: () => state.nextBefore && !loading && void load(state.nextBefore),
  }
}

/**
 * Everyone who's given, as a roll of tickets hanging from a spool in the business's colour. Newest first (each
 * new gift prints onto the top) or largest first. Only the tickets on screen are drawn, and older ones load as
 * the roll scrolls. Each ticket's ⋯ reports that donation.
 */
export function TicketRoll({
  slug,
  feed,
  onReport,
  className,
}: {
  slug: string
  feed: DonationFeed
  onReport: (donation: PublicDonation | null) => void
  className?: string
}) {
  const [sort, setSort] = useState<DonationSort>("recent")
  const top = useTopDonations(slug)
  const items = sort === "recent" ? feed.items : top.items
  const hasMore = sort === "recent" ? feed.hasMore : !!top.nextBefore
  const busy = sort === "recent" ? feed.loadingMore : top.loading
  const loadMore = sort === "recent" ? feed.loadMore : top.loadMore
  const count = feed.progress.donationsCount

  return (
    <section aria-labelledby="roll-title" className={cn("flex min-h-0 flex-col", className)}>
      <header className="grain relative z-10 flex items-center justify-between gap-3 rounded-b-[22px] bg-(--biz) px-5 py-4 text-(--on-biz) shadow-[0_12px_22px_-14px_oklch(0.15_0.03_252/0.7)]">
        <h2 id="roll-title" className="flex items-baseline gap-1.5 text-sm text-(--biz-muted)">
          <span className="type-display text-2xl text-(--on-biz)">
            <span className="figure">{count.toLocaleString("en-NG")}</span>
          </span>
          {count === 1 ? "gift" : "gifts"}
        </h2>
        <div role="group" aria-label="Order" className="flex rounded-full bg-[color-mix(in_oklch,var(--on-biz)_14%,transparent)] p-1">
          {(["recent", "top"] as const).map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={sort === key}
              onClick={() => {
                setSort(key)
                if (key === "top") top.open()
              }}
              className={cn(
                "h-7 rounded-full px-3 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-(--on-biz)",
                sort === key ? "bg-(--on-biz) text-(--biz)" : "text-(--on-biz) hover:bg-[color-mix(in_oklch,var(--on-biz)_12%,transparent)]",
              )}
            >
              {key === "recent" ? "Newest" : "Top"}
            </button>
          ))}
        </div>
      </header>
      {sort === "top" && !top.loaded ? (
        <div className="grid place-items-center py-16">
          <Spinner />
        </div>
      ) : items.length === 0 ? (
        <div className="mx-3 -mt-3 grid justify-items-start gap-2 rounded-b-[6px] border-2 border-t-0 border-dashed border-[color-mix(in_oklch,var(--foreground)_22%,transparent)] px-6 pt-9 pb-8">
          <span className="font-mono text-xs tracking-[0.06em] text-muted-foreground uppercase">{ticketNumber(1)}</span>
          <p className="type-display text-2xl">No tickets yet</p>
          <p className="text-sm text-pretty text-muted-foreground">The first gift prints here, at the top of the roll. It could be yours.</p>
        </div>
      ) : (
        <RollTickets
          key={sort}
          items={items}
          numberFor={(i) => (sort === "top" ? `Top ${i + 1}` : ticketNumber(count - i))}
          toneFor={(i) => (sort === "top" ? topTone(top.items, i) : count - i)}
          newestFirst={sort === "recent"}
          fresh={sort === "recent" ? feed.fresh : undefined}
          hasMore={hasMore}
          busy={busy}
          loadMore={loadMore}
          onReport={onReport}
        />
      )}
    </section>
  )
}

/** On the Top list, a colour from the donor's id, moved on one when it would match the ticket above. */
function topTone(items: PublicDonation[], index: number): number {
  const hash = (id: string) => [...id].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 0) % TONES.length
  let tone = hash(items[index]._id)
  if (index > 0 && tone === topTone(items, index - 1)) tone = (tone + 1) % TONES.length
  return tone
}

function RollTickets({
  items,
  numberFor,
  toneFor,
  newestFirst,
  fresh,
  hasMore,
  busy,
  loadMore,
  onReport,
}: {
  items: PublicDonation[]
  numberFor: (index: number) => string
  toneFor: (index: number) => number
  newestFirst: boolean
  fresh?: Set<string>
  hasMore: boolean
  busy: boolean
  loadMore: () => void
  onReport: (donation: PublicDonation) => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  // One extra row at the end holds the "loading more" spinner.
  const count = items.length + (hasMore ? 1 : 0)
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_ESTIMATE,
    getItemKey: (index) => items[index]?._id ?? "more",
    overscan: 4,
  })
  const rows = virtualizer.getVirtualItems()
  const lastIndex = rows.at(-1)?.index ?? -1

  useEffect(() => {
    if (hasMore && !busy && lastIndex >= items.length - PREFETCH_ROWS) loadMore()
  }, [hasMore, busy, lastIndex, items.length, loadMore])

  return (
    // Tucked under the spool, so the top ticket feeds out of it.
    <div ref={scrollRef} className="-mt-4 min-h-0 flex-auto overflow-y-auto overscroll-contain px-3 pb-6 [scrollbar-width:thin]">
      <ul aria-busy={busy} aria-label="Donations" className="relative" style={{ height: virtualizer.getTotalSize() }}>
        {rows.map((row) => {
          const d = items[row.index]
          const isFresh = !!d && !!fresh?.has(d._id)
          return (
            <li
              key={row.key}
              data-index={row.index}
              ref={virtualizer.measureElement}
              // Tickets glide down when a new one prints at the top.
              className="absolute top-0 left-0 w-full transition-transform duration-700 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none"
              style={{ transform: `translateY(${row.start}px)` }}
            >
              {d ? (
                <Ticket
                  label={numberFor(row.index)}
                  amountKobo={d.amountKobo}
                  name={d.name}
                  message={d.message}
                  when={timeAgo(d.paidAt ?? undefined)}
                  flag={isFresh ? "Just in" : row.index === 0 && newestFirst ? "Newest" : undefined}
                  toneKey={toneFor(row.index)}
                  perforated={row.index > 0}
                  className={cn(row.index === 0 ? "pt-7" : "", row.index === items.length - 1 && !hasMore && "rounded-b-[6px]", isFresh && "ticket-print")}
                  action={<TicketMenu name={d.name} onReport={() => onReport(d)} />}
                />
              ) : (
                <div className="grid place-items-center py-6">
                  <Spinner />
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function TicketMenu({ name, onReport }: { name: string | null; onReport: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`More for the donation from ${name ?? "Anonymous"}`}
          className="-mr-2 grid size-8 place-items-center rounded-full opacity-70 transition-[opacity,background-color] outline-none hover:bg-[color-mix(in_oklch,var(--tone-ink)_12%,transparent)] hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-(--tone-ink) data-[state=open]:opacity-100"
        >
          <MoreHorizontal className="size-4" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={onReport}>
          <Flag aria-hidden />
          Report this donation
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// ---------------------------------------------------------------------------------------------------------
// Reporting to LinkPay
// ---------------------------------------------------------------------------------------------------------

/** Same keys and wording as the backend's LINK_REPORT_REASONS. */
const REPORT_REASONS = [
  ["fraud", "It's a scam or the money won't go where it says"],
  ["misleading", "The story or the goal is misleading"],
  ["impersonation", "It pretends to be someone else"],
  ["prohibited", "It's raising money for something illegal"],
  ["offensive", "Offensive words or pictures, or an offensive donation message"],
  ["other", "Something else"],
] as const
type ReportReason = (typeof REPORT_REASONS)[number][0]

/**
 * Tells LinkPay something's wrong with the fundraiser, or with one donation on it. Goes to LinkPay's team,
 * never to the organiser. `donation` set = about that donation.
 */
export function ReportDialog({
  slug,
  businessName,
  donation,
  open,
  onOpenChange,
}: {
  slug: string
  businessName: string
  donation: PublicDonation | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [reason, setReason] = useState<ReportReason | "">(donation ? "offensive" : "")
  const [details, setDetails] = useState("")
  const [email, setEmail] = useState("")
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const next: Record<string, string> = {}
    if (!reason) next.reason = "Choose what's wrong."
    if (reason === "other" && details.trim().length < 10) next.details = "Tell us a little about what's wrong."
    if (email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) next.email = "Enter a valid email address, or leave it empty."
    setErrors(next)
    if (Object.keys(next).length) return
    setBusy(true)
    setError(undefined)
    try {
      const res = await fetch(`/api/pay/${encodeURIComponent(slug)}/reports`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reason,
          ...(details.trim() && { details: details.trim() }),
          ...(email.trim() && { email: email.trim() }),
          ...(donation && { donationId: donation._id }),
        }),
      })
      const json = await res.json().catch(() => null)
      if (res.ok) setSent(true)
      else
        setError(
          json?.code === "TOO_MANY_REPORTS"
            ? "You've sent several reports already. Try again later."
            : json?.code === "DONATION_NOT_FOUND"
              ? "That donation isn't on the page any more."
              : (json?.error ?? "We couldn't send your report. Try again."),
        )
    } catch {
      setError("We couldn't reach LinkPay. Check your connection and try again.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {sent ? (
          <div className="grid gap-5 py-2" role="status">
            <span className="pop-in grid size-12 place-items-center rounded-[30%] bg-primary text-primary-foreground">
              <Flag className="size-5" aria-hidden />
            </span>
            <DialogHeader>
              <DialogTitle className="type-display text-2xl">Thanks for telling us</DialogTitle>
              <DialogDescription className="text-[15px] leading-relaxed">
                LinkPay&apos;s team will look into it. {businessName} won&apos;t see your report.
                {email.trim() ? " If we need more from you, we'll email you." : ""}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>Done</Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={submit} noValidate className="grid gap-5">
            <DialogHeader>
              <DialogTitle className="type-display text-2xl">{donation ? "Report this donation" : "Report this fundraiser"}</DialogTitle>
              <DialogDescription>
                {donation ? (
                  <>
                    About the donation from <span className="font-medium text-foreground">{donation.name ?? "Anonymous"}</span>. Your report goes to
                    LinkPay&apos;s team, not to {businessName}.
                  </>
                ) : (
                  <>Your report goes to LinkPay&apos;s team, not to {businessName}. We review every one.</>
                )}
              </DialogDescription>
            </DialogHeader>
            {error && (
              <p role="alert" className="flex gap-2 rounded-xl bg-destructive-subtle px-3.5 py-3 text-sm text-destructive">
                <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                {error}
              </p>
            )}
            <Field data-invalid={!!errors.reason}>
              <FieldLabel id="report-reason">What&apos;s wrong?</FieldLabel>
              <RadioGroup aria-labelledby="report-reason" value={reason} onValueChange={(v) => setReason(v as ReportReason)} className="gap-2">
                {REPORT_REASONS.map(([key, label]) => (
                  <Label
                    key={key}
                    htmlFor={`report-${key}`}
                    className="flex cursor-pointer items-start gap-3 rounded-[10px] border px-3.5 py-3 text-sm leading-snug font-normal transition-colors hover:bg-muted/50 has-data-[state=checked]:border-primary has-data-[state=checked]:bg-muted/40"
                  >
                    <RadioGroupItem id={`report-${key}`} value={key} className="mt-0.5" />
                    {label}
                  </Label>
                ))}
              </RadioGroup>
              {errors.reason && <FieldError>{errors.reason}</FieldError>}
            </Field>
            <Field data-invalid={!!errors.details}>
              <FieldLabel htmlFor="report-details">Details{reason === "other" ? "" : " (optional)"}</FieldLabel>
              <Textarea
                id="report-details"
                rows={3}
                maxLength={2000}
                value={details}
                aria-invalid={!!errors.details}
                onChange={(e) => setDetails(e.target.value)}
                className="resize-none"
              />
              {errors.details && <FieldError>{errors.details}</FieldError>}
            </Field>
            <Field data-invalid={!!errors.email}>
              <FieldLabel htmlFor="report-email">Your email (optional)</FieldLabel>
              <Input
                id="report-email"
                type="email"
                inputMode="email"
                autoComplete="email"
                maxLength={200}
                value={email}
                aria-invalid={!!errors.email}
                onChange={(e) => setEmail(e.target.value)}
              />
              {errors.email ? <FieldError>{errors.email}</FieldError> : <FieldDescription>Only if you&apos;re happy for us to follow up.</FieldDescription>}
            </Field>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? <Spinner /> : <Flag data-icon="inline-start" aria-hidden />}
                Send report
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** The quiet "Report this fundraiser" link under the page. */
export function ReportLink({ onClick, className }: { onClick: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex w-fit items-center gap-1.5 rounded-md text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:underline focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
        className,
      )}
    >
      <Flag className="size-3.5" aria-hidden />
      Report this fundraiser
    </button>
  )
}
