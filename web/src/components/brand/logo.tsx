import { cn } from "@/lib/utils"

/** The LinkPay bridge. Keep in sync with MARK_PATH in scripts/brand-assets.ts (favicons, app icons). */
const MARK_PATH = "M0 0H374V144H345.6C332.9 97.7 291 26 187 26S41.1 97.7 28.4 144H0Z"

/** The bare mark in `currentColor`, 1em tall by default. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg aria-hidden focusable="false" viewBox="0 0 374 144" fill="currentColor" className={cn("block h-[1em] w-auto", className)}>
      <path d={MARK_PATH} />
    </svg>
  )
}

/**
 * The lockup, as on the LinkPay site: the bridge in `primary` (navy, lime in dark mode), then the
 * name in the display face. The font size drives everything (pass `text-sm` and so on to resize):
 * the mark is 0.78em tall, which matches the wordmark's cap height. `inverse` is for brand-surface
 * panels and only changes the text colours. `ink` is for the solid navy band: light text, lime mark.
 * "Business" sits on the same baseline at 0.62em, so it reads as LinkPay's business product, not a new brand.
 */
export function Logo({
  className,
  showProduct = true,
  inverse = false,
  ink = false,
}: {
  className?: string
  showProduct?: boolean
  inverse?: boolean
  ink?: boolean
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-[0.35em] text-[17px] leading-none",
        ink ? "text-ink-foreground" : inverse ? "text-brand-surface-foreground" : "text-foreground",
        className,
      )}
    >
      <LogoMark className={cn("h-[0.78em]", ink ? "text-pop" : "text-primary")} />
      <span className="font-display font-semibold tracking-[-0.02em]">
        linkPay
        {showProduct && (
          <span
            className={cn(
              "ml-[0.3em] text-[0.62em] font-medium tracking-normal",
              ink ? "text-ink-muted" : inverse ? "text-brand-surface-muted" : "text-muted-foreground",
            )}
          >
            Business
          </span>
        )}
      </span>
    </span>
  )
}
