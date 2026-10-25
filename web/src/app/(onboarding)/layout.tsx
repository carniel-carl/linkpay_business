import Link from "next/link"
import { redirect } from "next/navigation"
import { Logo } from "@/components/brand/logo"
import { NotificationBell } from "@/components/notifications/notification-bell"
import { NotificationsProvider } from "@/components/notifications/notifications-provider"
import { ProgressRail } from "@/components/onboarding/progress-rail"
import { UserMenu } from "@/components/shell/user-menu"
import { Button } from "@/components/ui/button"
import { getMe, getMemberships, getOverview, getUnreadNotificationCount } from "@/lib/data"
import { EDITABLE, stepStates } from "@/lib/onboarding"
import { CLOSED_PATH, isClosed } from "@/lib/restriction"

export default async function OnboardingLayout({ children }: LayoutProps<"/">) {
  const [user, overview, memberships, unread] = await Promise.all([
    getMe(),
    getOverview(),
    getMemberships(),
    getUnreadNotificationCount(),
  ])
  // Onboarding is the owner's job. Team members of someone else's business never land here.
  if (overview?.membership && overview.membership.role !== "owner") redirect("/dashboard")
  // Compliance can close a business before it's verified; it can't be resubmitted then.
  if (isClosed(overview)) redirect(CLOSED_PATH)
  const steps = stepStates(overview)
  const locked = !!overview && !EDITABLE.includes(overview.business.status)
  const items = overview?.checklist.items ?? []
  const done = items.filter((i) => i.done).length
  const pct = items.length ? Math.round((done / items.length) * 100) : 0

  const page = (
    <div className="min-h-dvh overflow-x-clip">
      <header className="sticky top-0 z-header bg-brand-surface text-brand-surface-foreground">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 md:px-8">
          <Link
            href="/dashboard"
            className="rounded-lg focus-visible:ring-3 focus-visible:ring-pop/40 focus-visible:outline-none"
          >
            <Logo inverse />
          </Link>
          <div className="flex items-center gap-2">
            {overview && (
              <Button
                variant="ghost"
                size="sm"
                className="text-brand-surface-muted hover:bg-brand-surface-foreground/10 hover:text-brand-surface-foreground"
                asChild
              >
                <Link href="/dashboard">Save and exit</Link>
              </Button>
            )}
            {overview && <NotificationBell />}
            <UserMenu user={user} showSettings={!!overview} tone="ink" />
          </div>
        </div>
      </header>
      <div className="grain bg-brand-surface text-brand-surface-foreground">
        <div className="mx-auto flex max-w-6xl flex-wrap items-end justify-between gap-6 px-4 pt-8 pb-28 md:px-8 md:pt-12">
          <div className="grid gap-2">
            <p className="text-sm text-brand-surface-muted">Business verification</p>
            <p className="type-display text-[2rem] sm:text-[2.75rem]">{overview?.business.name ?? "Your new business"}</p>
          </div>
          {items.length > 0 && (
            <div className="grid min-w-56 gap-2.5">
              <div className="flex items-end justify-between gap-4">
                <span className="type-display text-4xl leading-none figure">
                  {done}
                  <span className="text-brand-surface-muted">/{items.length}</span>
                </span>
                <span className="pb-1 text-sm text-brand-surface-muted">requirements done</span>
              </div>
              <div
                className="h-1.5 overflow-hidden rounded-full bg-brand-surface-foreground/12"
                role="progressbar"
                aria-valuenow={pct}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Requirements completed"
              >
                <div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${pct}%` }} />
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="relative mx-auto -mt-20 max-w-6xl px-2 pb-16 sm:px-4 md:px-8">
        <div className="surface grid gap-8 p-5 sm:p-8 lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-12 lg:p-10">
          <ProgressRail steps={steps} locked={locked} />
          <main id="main" className="page-enter min-w-0 max-w-2xl">
            {children}
          </main>
        </div>
      </div>
    </div>
  )

  // Live notifications once the business exists, so the verification decision shows up here straight away.
  if (!overview) return page
  return (
    <NotificationsProvider initialUnread={unread} businessId={overview.business._id} showBusiness={memberships.length > 1}>
      {page}
    </NotificationsProvider>
  )
}
