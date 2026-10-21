"use client"

import { useState, type CSSProperties, type ReactNode } from "react"
import { Check } from "lucide-react"
import { LogoMark } from "@/components/brand/logo"
import type { BrandPalette } from "@/lib/api/types"
import { formatNaira } from "@/lib/format"
import { cn } from "@/lib/utils"

/** The business's colours as CSS variables. Every tint on the page is mixed from these (see `pay-brand`). */
export function brandVars(p: BrandPalette) {
  return {
    "--biz": p.accent,
    "--on-biz": p.onAccent,
    "--biz-text": p.accentText,
  } as CSSProperties
}

/** Where the payer is: 0 details, 1 transfer, 2 confirmed. -1 when the link isn't taking payments. */
export type PayStep = -1 | 0 | 1 | 2

export const PAY_STEPS = [
  {
    title: "Your details",
    short: "Details",
    line: "Your name and email, for the receipt.",
  },
  {
    title: "Send the transfer",
    short: "Transfer",
    line: "From any Nigerian bank app, to the account we show you.",
  },
  {
    title: "Payment confirmed",
    short: "Confirmed",
    line: "We spot it as it lands and email your receipt.",
  },
] as const

/** ₦25,000 with the kobo set smaller, or highlighted when the kobo is what identifies the transfer. */
export function Money({ kobo, highlight = false, className }: { kobo: number; highlight?: boolean; className?: string }) {
  const text = formatNaira(kobo)
  const dot = text.lastIndexOf(".")
  const major = dot > 0 ? text.slice(0, dot) : text
  const minor = dot > 0 ? text.slice(dot) : ""
  return (
    <span className={cn("figure", className)}>
      {major}
      {minor &&
        (highlight ? (
          <mark className="ml-[0.04em] rounded-[0.14em] bg-(--biz) px-[0.1em] text-(--on-biz)">{minor}</mark>
        ) : (
          <span className="text-[0.5em] tracking-normal opacity-70">{minor}</span>
        ))}
    </span>
  )
}

/** The business's logo on a white squircle, or its initial in the brand colours. */
export function BusinessMark({ name, logoSrc, className }: { name: string; logoSrc: string | null; className?: string }) {
  if (logoSrc) {
    // The logo is the business's own upload, trimmed by the backend.
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={logoSrc} alt="" className={cn("size-11 shrink-0 rounded-[30%] bg-white object-contain p-1.5 shadow-sm", className)} />
  }
  return (
    <span
      aria-hidden
      className={cn("grid size-11 shrink-0 place-items-center rounded-[30%] bg-(--on-biz) font-display text-lg font-semibold text-(--biz)", className)}
    >
      {name.charAt(0)}
    </span>
  )
}

/** A picture ready to show: same-origin src plus its size, so the frame keeps the picture's shape. */
export type SummaryImage = { src: string; width: number; height: number }

/**
 * What the payer is paying for: business, pictures, title, description and price, on the business's colour.
 * Plain props only, so the dashboard's live preview can render it too. Wrap it in an element with
 * `pay-brand`, `brandVars(palette)` and `bg-(--biz) text-(--on-biz)`.
 * `panel` is the full-height side panel (and the phone band); `compact` is the embedded card's header.
 */
export function LinkSummary({
  businessName,
  logoSrc,
  title,
  description,
  amountKobo,
  minAmountKobo,
  images = [],
  variant = "panel",
  titleId,
  action,
  fitScreen = false,
}: {
  businessName: string
  logoSrc: string | null
  title: string
  description: string | null
  amountKobo: number | null
  minAmountKobo: number | null
  images?: SummaryImage[]
  variant?: "panel" | "compact"
  /** Id for the title, for aria-labelledby. */
  titleId?: string
  /** Shown at the end of the business row (the embed's close button). */
  action?: ReactNode
  /**
   * The pay page on a desktop: the panel is exactly one screen tall, so the picture takes whatever height is
   * left and the type steps down on short screens (`short:`). Leave off anywhere else.
   */
  fitScreen?: boolean
}) {
  const compact = variant === "compact"
  // With pictures the panel has more to hold, so the type steps down a size to keep the timeline on screen.
  const dense = images.length > 0
  const lockup = (
    <div className="flex items-center gap-3">
      <BusinessMark name={businessName} logoSrc={logoSrc} className={compact ? "size-10" : undefined} />
      <span className="min-w-0 flex-1 truncate text-[15px] font-medium">{businessName}</span>
      {action}
    </div>
  )

  if (compact) {
    const cover = images[0]
    return (
      <div className="grid gap-5">
        {lockup}
        <div className="flex items-start gap-4">
          {cover && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={cover.src}
              alt=""
              width={cover.width}
              height={cover.height}
              className="size-20 shrink-0 rounded-xl bg-(--biz-line) object-cover shadow-[0_6px_16px_-6px_oklch(0.15_0.03_252/0.45)]"
            />
          )}
          <div className="grid min-w-0 gap-1.5">
            <h1 id={titleId} className="type-display text-[1.75rem] text-balance">
              {title}
            </h1>
            {description && <p className="text-sm leading-relaxed text-pretty text-(--biz-muted)">{description}</p>}
          </div>
        </div>
        <Price amountKobo={amountKobo} minAmountKobo={minAmountKobo} size="md" />
      </div>
    )
  }

  return (
    <div className={cn("grid gap-7 lg:flex lg:flex-1 lg:flex-col", dense ? "lg:gap-6" : "lg:gap-10", fitScreen && "lg:min-h-0 short:gap-5")}>
      {lockup}
      <div
        className={cn(
          "grid gap-7",
          dense ? "lg:gap-7" : "lg:gap-10",
          fitScreen && dense ? "lg:flex lg:min-h-0 lg:flex-1 lg:flex-col lg:justify-center" : "lg:my-auto",
          fitScreen && "short:gap-5",
        )}
      >
        {images.length > 0 && <Gallery images={images} title={title} fill={fitScreen} />}
        <div className="grid gap-5">
          <div className="grid gap-3">
            <h1
              id={titleId}
              className={cn("type-display text-[2.25rem] text-balance sm:text-5xl", !dense && "xl:text-[3.5rem]", fitScreen && "short:text-4xl")}
            >
              {title}
            </h1>
            {description && (
              <p className={cn("max-w-[46ch] text-[15px] leading-relaxed text-pretty text-(--biz-muted)", fitScreen && "short:line-clamp-2")}>{description}</p>
            )}
          </div>
          <Price amountKobo={amountKobo} minAmountKobo={minAmountKobo} size={dense ? "dense" : "lg"} className={fitScreen ? "short:text-5xl" : undefined} />
        </div>
      </div>
    </div>
  )
}

/** The pictures at their own shape (a book cover stays a book cover), with thumbnails to switch when there are several. */
/** `fill`: on a desktop, take the height the panel has left (between 6rem and 24rem) instead of a fixed share of the screen. */
function Gallery({ images, title, fill = false }: { images: SummaryImage[]; title: string; fill?: boolean }) {
  const [index, setIndex] = useState(0)
  const shown = images[Math.min(index, images.length - 1)]
  return (
    <figure className={cn("relative w-fit max-w-full", fill && "lg:min-h-24 lg:max-h-96 lg:flex-1")}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        key={shown.src}
        src={shown.src}
        alt={images.length > 1 ? `${title}, picture ${index + 1} of ${images.length}` : title}
        width={shown.width}
        height={shown.height}
        style={{ aspectRatio: `${shown.width} / ${shown.height}` }}
        className={cn(
          "page-enter block h-auto max-h-[min(36vh,22rem)] w-auto max-w-full rounded-2xl bg-(--biz-line) object-cover shadow-[0_18px_40px_-18px_oklch(0.12_0.03_252/0.55)]",
          fill ? "lg:h-full lg:max-h-none" : "lg:max-h-[min(26vh,20rem)]",
        )}
      />
      {images.length > 1 && (
        <div role="group" aria-label="Pictures" className="absolute bottom-3 left-3 flex gap-1.5 rounded-[14px] bg-black/45 p-1.5">
          {images.map((img, i) => (
            <button
              key={img.src}
              type="button"
              aria-pressed={i === index}
              aria-label={`Show picture ${i + 1}`}
              onClick={() => setIndex(i)}
              className={cn(
                "size-10 overflow-hidden rounded-[10px] ring-2 transition-[opacity,box-shadow] duration-150 outline-none focus-visible:ring-white",
                i === index ? "ring-white" : "opacity-70 ring-transparent hover:opacity-100",
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

/** The price as the panel shows it: a fixed amount, or what the payer can enter. */
export function Price({
  amountKobo,
  minAmountKobo,
  size = "lg",
  className,
}: {
  amountKobo: number | null
  minAmountKobo: number | null
  size?: "lg" | "dense" | "md"
  className?: string
}) {
  if (amountKobo) {
    return (
      <p
        className={cn(
          "type-display wrap-break-word",
          size === "lg"
            ? "text-[3.25rem] sm:text-6xl xl:text-[4.5rem]"
            : size === "dense"
              ? "text-[3.25rem] sm:text-6xl lg:text-[3.25rem] xl:text-6xl"
              : "text-[2.75rem]",
          className,
        )}
      >
        <Money kobo={amountKobo} />
      </p>
    )
  }
  return (
    <div className="grid gap-1">
      <p className={cn("type-display", size === "md" ? "text-3xl" : "text-4xl sm:text-5xl", className && "short:text-4xl")}>Any amount</p>
      <p className="text-sm text-(--biz-muted)">
        {minAmountKobo && minAmountKobo > 100_00 ? (
          <>
            At least <span className="figure">{formatNaira(minAmountKobo)}</span>. You enter it on the form.
          </>
        ) : (
          "You enter it on the form."
        )}
      </p>
    </div>
  )
}

/** Done, current or still to come. A paid checkout counts every step as done. */
function stepState(i: number, step: PayStep) {
  return i < step || step === 2 ? "done" : i === step ? "current" : "next"
}

const STATE_LABEL = {
  done: "done",
  current: "current step",
  next: "to come",
} as const

/** The three steps of a bank-transfer payment as a vertical timeline on the brand panel. */
/** `dense` drops the one-line explanations on short screens, for panels that also hold pictures. */
export function StepTimeline({ step, dense = false, className }: { step: PayStep; dense?: boolean; className?: string }) {
  return (
    <ol aria-label="How paying works" className={cn("grid", className)}>
      {PAY_STEPS.map((s, i) => {
        const state = stepState(i, step)
        const filled = stepState(i + 1, step) !== "next"
        return (
          <li
            key={s.title}
            aria-current={state === "current" ? "step" : undefined}
            className={cn("relative grid grid-cols-[2rem_minmax(0,1fr)] gap-x-4 last:pb-0", dense ? "pb-5" : "pb-7", "short:pb-4")}
          >
            {i < PAY_STEPS.length - 1 && (
              <span
                aria-hidden
                className={cn(
                  "absolute top-[2.125rem] bottom-0.5 left-[calc(1rem-1px)] w-0.5 rounded-full transition-colors duration-500",
                  filled ? "bg-(--on-biz)" : "bg-(--biz-line)",
                )}
              />
            )}
            <span
              aria-hidden
              className={cn(
                "grid size-8 place-items-center rounded-full transition-[background-color,border-color,box-shadow] duration-300",
                state === "done" && "bg-(--on-biz) text-(--biz)",
                state === "current" && "border-2 border-(--on-biz) shadow-[0_0_0_6px_color-mix(in_oklch,var(--on-biz)_14%,transparent)]",
                state === "next" && "border-2 border-(--biz-line) text-(--biz-muted)",
              )}
            >
              {state === "done" ? (
                <Check className="size-4" strokeWidth={3} />
              ) : state === "current" ? (
                <span className="size-2.5 rounded-full bg-(--on-biz)" />
              ) : (
                <span className="figure text-xs font-medium">{i + 1}</span>
              )}
            </span>
            <div className="grid gap-0.5 pt-1">
              <p className={cn("text-[15px] leading-6 font-medium", state === "next" && "text-(--biz-muted)")}>
                {s.title}
                <span className="sr-only">, {STATE_LABEL[state]}</span>
              </p>
              <p className={cn("text-sm leading-relaxed text-(--biz-muted)", dense && "[@media(max-height:960px)]:hidden", "short:hidden")}>{s.line}</p>
            </div>
          </li>
        )
      })}
    </ol>
  )
}

/** The same three steps as a horizontal track, for the sheet on phones and in embeds. */
export function StepTrack({ step, className }: { step: PayStep; className?: string }) {
  if (step < 0) return null
  return (
    <ol aria-label="Progress" className={cn("grid grid-cols-3", className)}>
      {PAY_STEPS.map((s, i) => {
        const state = stepState(i, step)
        return (
          <li key={s.title} aria-current={state === "current" ? "step" : undefined} className="relative grid justify-items-center gap-1.5 text-center">
            {i > 0 && (
              <span
                aria-hidden
                className={cn(
                  "absolute top-[calc(0.75rem-1px)] right-[calc(50%+1.25rem)] left-[calc(-50%+1.25rem)] h-0.5 rounded-full transition-colors duration-500",
                  state === "next" ? "bg-border" : "bg-(--biz-strong)",
                )}
              />
            )}
            <span
              aria-hidden
              className={cn(
                "grid size-6 place-items-center rounded-full transition-colors duration-300",
                state === "done" && "bg-(--biz) text-(--on-biz) dark:ring-1 dark:ring-white/25",
                state === "current" && "border-2 border-(--biz-strong)",
                state === "next" && "border-2 border-border text-muted-foreground",
              )}
            >
              {state === "done" ? (
                <Check className="size-3.5" strokeWidth={3} />
              ) : state === "current" ? (
                <span className="size-2 rounded-full bg-(--biz-strong)" />
              ) : (
                <span className="figure text-[11px] font-medium">{i + 1}</span>
              )}
            </span>
            <span className={cn("text-xs", state === "current" ? "font-medium text-foreground" : "text-muted-foreground")}>
              {s.short}
              <span className="sr-only">, {STATE_LABEL[state]}</span>
            </span>
          </li>
        )
      })}
    </ol>
  )
}

/** "Secured by LinkPay Business", in the colour of whatever it sits on. */
export function Secured({ businessName, className }: { businessName: string; className?: string }) {
  return (
    <p className={cn("text-xs leading-relaxed", className)}>
      Paid by bank transfer straight into {businessName}&apos;s account.{" "}
      <span className="inline-flex items-center gap-1 whitespace-nowrap">
        Secured by
        <LogoMark className="h-[0.7em]" />
        <span className="font-display font-semibold tracking-[-0.02em]">linkPay</span> Business
      </span>
    </p>
  )
}

/** The tear line between the amount and the account on the transfer slip. Notches only where the page ground shows. */
export function Perforation({ notched }: { notched: boolean }) {
  return (
    <div aria-hidden className="relative h-7">
      <div className="absolute inset-x-6 top-1/2 border-t-2 border-dashed border-border sm:inset-x-8" />
      {notched && (
        <>
          <span className="absolute top-1/2 -left-3.5 size-7 -translate-y-1/2 rounded-full bg-background shadow-[inset_-2px_0_3px_oklch(0.3_0.04_252/0.16)]" />
          <span className="absolute top-1/2 -right-3.5 size-7 -translate-y-1/2 rounded-full bg-background shadow-[inset_2px_0_3px_oklch(0.3_0.04_252/0.16)]" />
        </>
      )}
    </div>
  )
}

/** A NUBAN read in groups (012 345 6789). The gaps are spacing, not characters, so copying gives the plain number. */
export function AccountNumber({ value, className }: { value: string; className?: string }) {
  const parts = /^\d{10}$/.test(value) ? [value.slice(0, 3), value.slice(3, 6), value.slice(6)] : [value]
  return (
    <span className={cn("inline-flex gap-[0.4em] font-mono font-medium tracking-[0.04em]", className)}>
      {parts.map((p, i) => (
        <span key={i}>{p}</span>
      ))}
    </span>
  )
}
