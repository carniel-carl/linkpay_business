import Link from "next/link"
import { ShieldCheck } from "lucide-react"
import { Logo } from "@/components/brand/logo"
import { cn } from "@/lib/utils"
import type { Ledger } from "./ledgers"
import { ThemeSwitch } from "./theme-switch"

/**
 * The auth frame (sign in, sign up, codes, 2FA, invites). A navy band holds the page title like a
 * statement header; the form sheet drops through the band's lower edge; the screen's facts sit
 * underneath as ruled ledger rows, with the row you're on marked.
 *
 * Grid: on desktop, five columns (gutter, title and ledger, gap, sheet, gutter). The sheet spans
 * down to the flexible row, so its height never stretches the band. On phones it is one column
 * and the sheet overlaps the band with a negative margin.
 *
 * Bold parts of `description` use <strong>, which the band styles in light ink.
 * Without children there is no sheet (dead ends): `action` sits in the band instead.
 */
export function AuthFrame({
  title,
  description,
  sheetTitle,
  ledger,
  action,
  children,
}: {
  title: string
  description?: React.ReactNode
  sheetTitle?: string
  ledger: Ledger
  action?: React.ReactNode
  children?: React.ReactNode
}) {
  const hasSheet = !!children
  return (
    <div
      className={cn(
        "grid min-h-dvh [&_input]:caret-primary",
        "grid-cols-[1rem_minmax(0,1fr)_1rem] grid-rows-[auto_auto_auto_auto_1fr_auto] sm:grid-cols-[2rem_minmax(0,1fr)_2rem]",
        "lg:grid-cols-[minmax(2.5rem,1fr)_minmax(0,44rem)_clamp(3rem,7vw,7rem)_minmax(0,29rem)_minmax(2.5rem,1fr)] lg:grid-rows-[auto_auto_auto_1fr_auto]",
      )}
    >
      {/* The band: header and title rows, edge to edge. */}
      <div aria-hidden className="grain col-span-full row-[1/3] bg-ink" />

      <header className="relative col-2 row-1 flex h-16 items-center justify-between gap-4 lg:col-[2/5] lg:h-20">
        <Link
          href="/"
          className="rounded-md focus-visible:ring-3 focus-visible:ring-pop/50 focus-visible:outline-none"
        >
          <Logo ink />
        </Link>
        <ThemeSwitch />
      </header>

      <div
        className={cn(
          "relative col-2 row-2 grid content-end gap-4 pt-8 text-ink-foreground lg:min-h-[clamp(19rem,44dvh,25rem)] lg:pt-12 lg:pb-16",
          hasSheet ? "pb-24 lg:col-2" : "pb-12 lg:col-[2/5]",
        )}
      >
        <h1 className="type-display max-w-[13ch] text-[2.5rem] leading-[0.98] tracking-[-0.04em] text-balance sm:text-[3.25rem] lg:text-[clamp(3.5rem,5.6vw,5.75rem)]">
          {title}
        </h1>
        {description && (
          <p className="max-w-136 text-[15px] leading-relaxed text-pretty text-ink-muted sm:text-base lg:text-[17px] [&_strong]:font-medium [&_strong]:text-ink-foreground">
            {description}
          </p>
        )}
        {action && <div className="pt-4">{action}</div>}
      </div>

      {hasSheet && (
        <section
          aria-label={sheetTitle}
          className="surface page-enter relative z-10 col-2 row-3 -mt-16 self-start p-6 sm:p-8 lg:col-4 lg:row-[2/5] lg:mt-2 lg:mb-12"
        >
          {sheetTitle && <h2 className="type-display mb-6 text-[1.625rem] tracking-[-0.03em]">{sheetTitle}</h2>}
          {children}
        </section>
      )}

      <AuthLedger
        ledger={ledger}
        className={cn("col-2 pt-10 lg:row-3 lg:pt-12", hasSheet ? "row-4" : "row-3")}
      />

      <footer className="col-2 row-6 flex flex-wrap items-center justify-between gap-x-8 gap-y-2 py-6 text-xs text-muted-foreground lg:col-[2/5] lg:row-5">
        <p>LinkPay Business is for businesses registered in Nigeria.</p>
        <p className="flex items-center gap-1.5">
          <ShieldCheck className="size-3.5" aria-hidden />
          Accounts are held with our partner bank.
        </p>
      </footer>
    </div>
  )
}

/** Ruled rows of facts for the screen. Numbered only when the rows are steps in order. */
function AuthLedger({ ledger, className }: { ledger: Ledger; className?: string }) {
  const { label, rows, current, numbered } = ledger
  const List = numbered ? "ol" : "ul"
  return (
    <section aria-label={label} className={cn("max-w-176", className)}>
      <div className="flex items-baseline justify-between gap-4 border-b border-foreground/80 pb-3 text-sm">
        <h2 className="font-medium">{label}</h2>
        <span className="figure text-muted-foreground">
          {rows.length} {numbered ? "steps" : rows.length === 1 ? "item" : "items"}
        </span>
      </div>
      <List className="stagger">
        {rows.map((row, i) => {
          const here = row.key === current
          return (
            <li
              key={row.key}
              style={{ "--i": i } as React.CSSProperties}
              aria-current={here ? "step" : undefined}
              className={cn(
                "grid items-baseline gap-x-4 gap-y-1 border-b py-3.5 text-sm",
                numbered
                  ? "grid-cols-[1.75rem_minmax(0,1fr)] sm:grid-cols-[1.75rem_15rem_minmax(0,1fr)]"
                  : "grid-cols-1 sm:grid-cols-[15rem_minmax(0,1fr)] sm:pl-0",
              )}
            >
              {numbered && <span className="figure text-muted-foreground">{i + 1}</span>}
              <span className="flex flex-wrap items-center gap-2 font-medium">
                {row.title}
                {here && (
                  <span className="rounded-[6px] bg-primary px-1.5 py-0.5 text-[11px] leading-none font-medium text-primary-foreground">
                    You&apos;re here
                  </span>
                )}
              </span>
              <span className={cn("text-muted-foreground", numbered && "col-start-2 sm:col-start-auto")}>
                {row.detail}
              </span>
            </li>
          )
        })}
      </List>
    </section>
  )
}
