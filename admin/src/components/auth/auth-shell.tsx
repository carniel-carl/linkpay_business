import Link from "next/link";
import { Logo, LogoMark } from "@/components/brand/logo";

// Session limits from backend/src/services/staffAuth.ts (STAFF_SESSION_MAX_AGE_MS, STAFF_SESSION_IDLE_MS).
const RULES = [
  {
    title: "Two-step every time",
    detail: (
      <>
        After your password, a 6-digit code from your email or authenticator
        app.
      </>
    ),
  },
];

/**
 * The staff sign-in frame: one slip on paper with a navy counterfoil joined by a perforation.
 * The form steps render in the slip; the counterfoil carries the access rules for every step.
 */
export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col px-4 py-6 sm:px-8 lg:px-12">
      <Link
        href="/sign-in"
        className="w-fit rounded-md focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <span className="flex items-center gap-2">
          <Logo showProduct={false} />
          {/* Same lockup as the console sidebar. */}
          <span className="rounded-md border border-border px-1.5 py-px text-[11px] font-medium text-muted-foreground">
            Staff
          </span>
        </span>
      </Link>

      <main className="flex flex-1 items-center justify-center py-10">
        <div className="page-enter relative grid w-full max-w-[58rem] rounded-[1.25rem] shadow-[var(--shadow-surface)] md:grid-cols-[minmax(0,1fr)_19rem]">
          {/* Above the counterfoil, so on entry it slides out from under the slip. */}
          <section className="relative z-10 flex flex-col justify-center rounded-t-[1.25rem] bg-card px-6 py-9 text-card-foreground sm:px-12 sm:py-12 md:rounded-l-[1.25rem] md:rounded-tr-none">
            {children}
          </section>

          <aside
            aria-label="Staff access rules"
            className="foil-enter relative flex flex-col gap-6 rounded-b-[1.25rem] border-t-2 border-dashed border-card bg-foil px-6 py-8 text-foil-foreground sm:px-8 md:rounded-l-none md:rounded-r-[1.25rem] md:border-t-0 md:border-l-2 md:py-12"
          >
            <Notch className="-top-3.5 -left-3.5 md:hidden" />
            <Notch className="-top-3.5 -right-3.5 md:hidden" />
            <span className="grid size-10 place-items-center rounded-[30%] bg-pop text-pop-foreground">
              <LogoMark className="h-2.5" />
            </span>
            <h2 className="type-display text-2xl">Staff access</h2>
            <dl className="grid gap-5 text-sm">
              {RULES.map((rule) => (
                <div key={rule.title} className="grid gap-1">
                  <dt className="font-medium">{rule.title}</dt>
                  <dd className="leading-relaxed text-foil-muted">
                    {rule.detail}
                  </dd>
                </div>
              ))}
            </dl>
          </aside>

          {/* The perforation's notches, cut where the tear line meets the card's edge (md and up). */}
          <Notch className="-top-3.5 right-[calc(19rem-0.875rem)] hidden md:block" />
          <Notch className="-bottom-3.5 right-[calc(19rem-0.875rem)] hidden md:block" />
        </div>
      </main>

      <p className="text-center text-xs text-muted-foreground">
        For LinkPay staff only. Trouble signing in? Ask another member of staff.
      </p>
    </div>
  );
}

function Notch({ className }: { className: string }) {
  return (
    <span
      aria-hidden
      className={`absolute z-20 size-7 rounded-full bg-background ${className}`}
    />
  );
}

function Figure({ children }: { children: React.ReactNode }) {
  return (
    <span className="figure font-medium whitespace-nowrap text-pop">
      {children}
    </span>
  );
}
