import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { BalanceVisibilityProvider } from "@/components/accounts/balance-visibility"
import { StatusBadge } from "@/components/business/status-badge"
import { NotificationBell } from "@/components/notifications/notification-bell"
import { NotificationsProvider } from "@/components/notifications/notifications-provider"
import { RecoveryCodeNotice } from "@/components/settings/recovery-code-notice"
import { AppSidebar } from "@/components/shell/app-sidebar"
import { ClearStaleBusiness } from "@/components/shell/clear-stale-business"
import { PinnedHeader } from "@/components/shell/pinned-header"
import { SuspendedBadge, SuspendedBanner } from "@/components/shell/restriction-banner"
import { StatusBanner } from "@/components/shell/status-banner"
import { UserMenu } from "@/components/shell/user-menu"
import { ReadOnlyProvider } from "@/components/shell/write-gate"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { BALANCES_HIDDEN_COOKIE } from "@/lib/balance-visibility"
import { getBusinessCookie } from "@/lib/business-context"
import { getMe, getMemberships, getOverview, getSelected, getUnreadNotificationCount } from "@/lib/data"
import { can, isOwner, roleLabel } from "@/lib/permissions"
import { CLOSED_PATH, isClosed, isSuspended, suspendedHint } from "@/lib/restriction"

export default async function DashboardLayout({ children }: LayoutProps<"/">) {
  const [user, overview, selected, memberships, businessCookie, jar, unread] = await Promise.all([
    getMe(),
    getOverview(),
    getSelected(),
    getMemberships(),
    getBusinessCookie(),
    cookies(),
    getUnreadNotificationCount(),
  ])
  if (!overview) redirect("/onboarding")
  // A closed business gets nothing from the API, so it gets no dashboard either. Pages also send a BUSINESS_BANNED
  // read there (lib/data.ts), for a ban that lands while this layout stays on screen.
  if (isClosed(overview)) redirect(CLOSED_PATH)

  const { business, membership } = overview
  const approved = business.status === "approved"
  const suspended = isSuspended(overview)

  return (
    <NotificationsProvider initialUnread={unread} businessId={business._id} showBusiness={memberships.length > 1}>
      <SidebarProvider defaultOpen={jar.get("sidebar_state")?.value !== "false"}>
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-full focus:bg-pop focus:px-4 focus:py-2 focus:text-pop-foreground"
        >
          Skip to content
        </a>
        <AppSidebar
          approved={approved}
          businessName={business.name}
          headOfficeCity={[business.address?.city, business.address?.state].filter(Boolean).join(", ") || undefined}
          branches={(overview.branches ?? []).map((b) => ({
            id: b._id,
            name: b.name,
            isHeadOffice: b.isHeadOffice,
            detail: b.address?.city || b.account?.accountNumber || undefined,
          }))}
          selectedBranchId={selected?._id ?? null}
          canManageBranches={can(overview, "branches.manage")}
          businessId={business._id}
          memberships={memberships}
          permissions={membership?.permissions}
        />
        {/* The cookie names a business the user was removed from; reads above fell back to their default. */}
        {businessCookie && businessCookie !== business._id && <ClearStaleBusiness />}
        {/* After a sign-in with a recovery code: one notice of how many are left. */}
        <RecoveryCodeNotice />
        {/* The header is fixed (see PinnedHeader) and tracks this sheet's width as the sidebar collapses. */}
        <SidebarInset
          data-band
          className="overflow-x-clip bg-[linear-gradient(to_bottom,var(--brand-surface)_0,var(--brand-surface)_14rem,var(--background)_14rem)] md:peer-data-[variant=inset]:rounded-2xl"
        >
          <PinnedHeader>
            <SidebarTrigger className="-ml-1.5 text-brand-surface-muted hover:bg-brand-surface-foreground/10 hover:text-brand-surface-foreground" />
            <div className="flex min-w-0 flex-1 items-center gap-2.5">
              <span className="truncate text-sm text-brand-surface-muted md:hidden">{business.name}</span>
              {suspended ? <SuspendedBadge /> : <StatusBadge status={business.status} tone="ink" />}
              {membership && !isOwner(membership) && (
                <span className="hidden truncate text-xs text-brand-surface-muted sm:inline">
                  Your role: {roleLabel(membership.role)}
                </span>
              )}
            </div>
            <NotificationBell />
            <UserMenu user={user} tone="ink" />
          </PinnedHeader>
          <StatusBanner overview={overview} />
          {suspended && <SuspendedBanner businessName={business.name} />}
          <main id="main" className="page-enter w-full max-w-6xl flex-1 px-4 pb-16 md:px-8">
            <BalanceVisibilityProvider defaultHidden={jar.get(BALANCES_HIDDEN_COOKIE)?.value === "true"}>
              {/* Suspended: write actions wrapped in WriteGate show disabled, with the reason. */}
              <ReadOnlyProvider reason={suspended ? suspendedHint(business.name) : null}>{children}</ReadOnlyProvider>
            </BalanceVisibilityProvider>
          </main>
        </SidebarInset>
      </SidebarProvider>
    </NotificationsProvider>
  )
}
