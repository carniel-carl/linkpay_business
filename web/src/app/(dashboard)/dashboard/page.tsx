import type { Metadata } from "next"
import Link from "next/link"
import { ArrowRight, ArrowUpRight, Check, Fingerprint, KeyRound, TriangleAlert } from "lucide-react"
import { HomeAccount } from "@/components/accounts/home-account"
import { BusinessSummary } from "@/components/business/business-summary"
import { PageHeader } from "@/components/common/page-header"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import type { Overview, User } from "@/lib/api/types"
import { homeBranch, setupStatusFor } from "@/lib/branches"
import { getAccounts, getMe, getOverview, getSelected, getTransactions, getTransactionSummary } from "@/lib/data"
import { initials } from "@/lib/format"
import { BUSINESS_TYPE_INFO, ROLE_LABELS } from "@/lib/kyb"
import { stepStates } from "@/lib/onboarding"
import { can } from "@/lib/permissions"
import { parseTransactionQuery, summaryParams, toApiParams } from "@/lib/transactions"
import { cn } from "@/lib/utils"

export const metadata: Metadata = { title: "Home" }

function greeting() {
  const hour = Number(
    new Intl.DateTimeFormat("en-NG", { hour: "numeric", hour12: false, timeZone: "Africa/Lagos" }).format(new Date()),
  )
  return hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening"
}

export default async function HomePage() {
  const [user, overview] = await Promise.all([getMe(), getOverview()])
  if (!overview) return null
  const firstName = user.name.split(" ")[0]
  const { business } = overview
  const approved = business.status === "approved"
  const seesAccounts = can(overview, "accounts.view")
  // Only approved businesses can call /api/accounts, and only members allowed to see accounts.
  const [accounts, selected] = approved && seesAccounts ? await Promise.all([getAccounts(), getSelected()]) : [null, null]
  const recent = accounts ? await loadRecent(selected?._id, (overview.branches?.length ?? 0) > 1 && !selected) : null
  // The selected branch's account, else the head office's (or a branch-limited member's first branch).
  const homeBranchId = homeBranch(overview, selected)?._id
  const fallbackAccount =
    overview.accounts?.find((a) => (typeof a.branch === "string" ? a.branch : a.branch?._id) === homeBranchId) ??
    overview.accounts?.[0]

  return (
    <>
      <PageHeader
        title={`${greeting()}, ${firstName}`}
        description={`${business.name}, ${BUSINESS_TYPE_INFO[business.type].label.toLowerCase()}`}
      />
      <div className="stagger grid gap-8">
        <div style={{ "--i": 0 } as React.CSSProperties}>
          {approved && accounts ? (
            <HomeAccount
              key={`${business._id}:${selected?._id ?? "all"}`}
              businessId={business._id}
              initial={accounts}
              setupStatus={setupStatusFor(overview, selected)}
              fallback={fallbackAccount}
              showWelcome={can(overview, "team.manage")}
              recent={recent}
            />
          ) : approved ? (
            <NoAccountAccess />
          ) : (
            <VerificationCard overview={overview} />
          )}
        </div>

        <div style={{ "--i": 1 } as React.CSSProperties} className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_21rem]">
          <section className="surface p-6 sm:p-8">
            <SectionHeading title="Business profile" hint="As registered with CAC" />
            <BusinessSummary business={business} className="mt-6" />
          </section>
          <div className="grid content-start gap-8">
            <Security user={user} />
            {/* Staff below admin get no people from the API, so don't show an empty list as fact. */}
            {can(overview, "team.manage") && <People overview={overview} />}
          </div>
        </div>
      </div>
    </>
  )
}

/** The 5 latest transactions and this month's money in, for the selected branch (or all). */
async function loadRecent(branchId: string | undefined, showBranch: boolean) {
  const now = new Date()
  const month = parseTransactionQuery({ period: "month" })
  const [list, summary] = await Promise.all([
    getTransactions(toApiParams({ ...parseTransactionQuery({ period: "all" }), size: 5 }, branchId, now)),
    getTransactionSummary(summaryParams(month, branchId, now)),
  ])
  if (!list.ok) return null
  return { items: list.data.items, moneyInKobo: summary.ok ? summary.data.inflowKobo : null, showBranch }
}

function SectionHeading({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <h2 className="font-display text-lg font-semibold tracking-[-0.02em]">{title}</h2>
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  )
}

/** A member whose role doesn't include seeing accounts. */
function NoAccountAccess() {
  return (
    <section className="surface grid gap-2 p-6 sm:p-9">
      <h2 className="type-display text-[1.75rem]">Accounts aren&apos;t part of your role</h2>
      <p className="max-w-[52ch] text-[15px] leading-relaxed text-muted-foreground">
        Ask the business owner or an admin if you need to see account numbers and balances.
      </p>
    </section>
  )
}

/** Not yet approved: real checklist progress and the single next action. */
function VerificationCard({ overview }: { overview: Overview }) {
  const { status } = overview.business
  const items = overview.checklist.items
  const done = items.filter((i) => i.done).length
  const steps = stepStates(overview).slice(1, 4)
  const editable = status === "draft" || status === "changes_requested"
  const next = steps.find((s) => !s.done || s.needsAttention)
  const pct = items.length ? Math.round((done / items.length) * 100) : 0

  const copy = {
    draft: {
      title: done === items.length ? "Ready to submit" : "Finish verifying your business",
      body: "Accounts, transfers and invoices unlock once we've verified your documents.",
      href: next?.href ?? "/onboarding/review",
      cta: next ? `Continue: ${next.label.toLowerCase()}` : "Review and submit",
    },
    submitted: {
      title: "We're reviewing your business",
      body: "Most reviews take 1 to 2 business days. We'll email you the outcome.",
      href: "/onboarding/status",
      cta: "View status",
    },
    changes_requested: {
      title: "A few changes needed",
      body: "Our review team flagged some items. Fix them, then resubmit.",
      href: "/onboarding/status",
      cta: "See what to fix",
    },
    rejected: {
      title: "We couldn't verify this business",
      body: "See the reason and how to contact support.",
      href: "/onboarding/status",
      cta: "See why",
    },
    approved: { title: "", body: "", href: "/dashboard", cta: "" },
  }[status]

  return (
    <section aria-labelledby="verification-title" className="surface grid overflow-hidden md:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
      <div className="grid content-between gap-10 p-6 sm:p-9">
        <div className="grid gap-3">
          <h2 id="verification-title" className="type-display text-[2rem] sm:text-[2.5rem]">
            {copy.title}
          </h2>
          <p className="max-w-[46ch] text-[15px] leading-relaxed text-muted-foreground">{copy.body}</p>
        </div>
        <div className="grid gap-4">
          <div className="flex items-end gap-3">
            <span className="type-display text-6xl leading-none figure">{done}</span>
            <span className="pb-1.5 text-sm text-muted-foreground figure">of {items.length} requirements</span>
          </div>
          <div className="h-1.5 max-w-sm overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Requirements completed">
            <div className="h-full rounded-full bg-primary transition-transform duration-500" style={{ width: `${pct}%` }} />
          </div>
          <Button className="mt-2 w-fit" asChild>
            <Link href={copy.href}>
              {copy.cta}
              <ArrowRight data-icon="inline-end" aria-hidden />
            </Link>
          </Button>
        </div>
      </div>

      <ol className="grid content-center gap-1 border-t bg-muted/60 p-4 sm:p-6 md:border-t-0 md:border-l">
        {steps.map((step) => {
          const row = (
            <>
              <span
                className={cn(
                  "grid size-7 shrink-0 place-items-center rounded-[9px]",
                  step.needsAttention
                    ? "bg-warning-subtle text-warning-foreground"
                    : step.done
                      ? "bg-primary text-primary-foreground"
                      : "bg-card text-muted-foreground shadow-surface",
                )}
              >
                {step.needsAttention ? (
                  <TriangleAlert className="size-3.5" aria-label="Needs attention" />
                ) : step.done ? (
                  <Check className="size-3.5" aria-label="Done" />
                ) : null}
              </span>
              <span className="grid flex-1">
                <span className="text-sm font-medium">{step.label}</span>
                <span className="text-xs text-muted-foreground figure">
                  {step.needsAttention ? "Needs your attention" : `${step.completed} of ${step.total} done`}
                </span>
              </span>
              {editable && <ArrowUpRight className="size-4 text-muted-foreground opacity-0 transition-opacity duration-200 group-hover:opacity-100" aria-hidden />}
            </>
          )
          return (
            <li key={step.key}>
              {editable ? (
                <Link
                  href={step.href}
                  className="group flex items-center gap-3.5 rounded-xl px-3 py-3 transition-colors duration-200 hover:bg-card focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:outline-none"
                >
                  {row}
                </Link>
              ) : (
                <div className="flex items-center gap-3.5 px-3 py-3">{row}</div>
              )}
            </li>
          )
        })}
      </ol>
    </section>
  )
}

function Security({ user }: { user: User }) {
  const on = user.twoFactor?.enabled
  return (
    <section className="surface grid gap-5 p-6">
      <div className="flex items-start gap-3.5">
        <span
          className={cn(
            "grid size-10 shrink-0 place-items-center rounded-[12px]",
            on ? "bg-brand-subtle text-primary" : "bg-warning-subtle text-warning-foreground",
          )}
        >
          <Fingerprint className="size-5" aria-hidden />
        </span>
        <div className="grid gap-1">
          <p className="font-display text-base font-semibold tracking-[-0.01em]">
            {on ? "Two-step verification on" : "Two-step verification off"}
          </p>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {on
              ? user.twoFactor?.method === "totp"
                ? "Codes come from your authenticator app."
                : "Codes come to your email."
              : "A stolen password alone could get someone in."}
          </p>
        </div>
      </div>
      <Button variant={on ? "outline" : "default"} size="sm" className="w-fit" asChild>
        <Link href="/settings/security">
          <KeyRound data-icon="inline-start" aria-hidden />
          {on ? "Manage" : "Turn it on"}
        </Link>
      </Button>
    </section>
  )
}

function People({ overview }: { overview: Overview }) {
  const { people } = overview.business
  return (
    <section className="grid gap-4 px-1">
      <SectionHeading title="Owners and directors" />
      {people.length === 0 ? (
        <p className="text-sm text-muted-foreground">No one added yet.</p>
      ) : (
        <ul className="grid gap-3">
          {people.map((p) => (
            <li key={p._id} className="flex items-center gap-3">
              <Avatar className="size-9 after:hidden">
                <AvatarFallback className="bg-card font-display text-xs font-semibold shadow-surface">
                  {initials(p.fullName)}
                </AvatarFallback>
              </Avatar>
              <div className="grid min-w-0">
                <span className="truncate text-sm font-medium">{p.fullName}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {p.roles.map((r) => ROLE_LABELS[r]).join(", ")}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
