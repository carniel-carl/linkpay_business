import { cookies } from "next/headers"
import { AdminSidebar } from "@/components/admin/admin-sidebar"
import { NotificationBell } from "@/components/notifications/notification-bell"
import { PinnedHeader } from "@/components/shell/pinned-header"
import { UserMenu } from "@/components/shell/user-menu"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { getAdminSummary, getSecuritySummary, getStaff, getStaffRoles, getUnreadNotifications } from "@/lib/data"
import { can, roleLabel } from "@/lib/permissions"

export default async function ConsoleLayout({ children }: LayoutProps<"/">) {
  // An ended or missing session redirects to sign in (see lib/data.ts), so past this line staff is signed in.
  const [staff, roles, unread, jar] = await Promise.all([getStaff(), getStaffRoles(), getUnreadNotifications(), cookies()])
  // A role without businesses.view (or a staff member with no role yet) gets no counts.
  const summary = can(staff, "businesses.view") ? await getAdminSummary() : null
  const security = can(staff, "security.review") ? await getSecuritySummary() : null

  return (
    <SidebarProvider defaultOpen={jar.get("sidebar_state")?.value !== "false"}>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-full focus:bg-pop focus:px-4 focus:py-2 focus:text-pop-foreground"
      >
        Skip to content
      </a>
      <AdminSidebar
        summary={summary}
        security={security}
        access={{
          staff: can(staff, "staff.manage"),
          activity: can(staff, "activity.view"),
          compliance: can(staff, "compliance.view"),
          security: can(staff, "security.review"),
        }}
      />
      {/* Same framed sheet as the business dashboard; the header is fixed (see PinnedHeader). */}
      <SidebarInset
        data-band
        className="overflow-x-clip bg-[linear-gradient(to_bottom,var(--brand-surface)_0,var(--brand-surface)_14rem,var(--background)_14rem)] md:peer-data-[variant=inset]:rounded-2xl"
      >
        <PinnedHeader>
          <SidebarTrigger className="-ml-1.5 text-brand-surface-muted hover:bg-brand-surface-foreground/10 hover:text-brand-surface-foreground" />
          <p className="min-w-0 flex-1 truncate text-sm text-brand-surface-muted">Staff console</p>
          <NotificationBell initialUnread={unread} />
          <UserMenu staff={staff} role={roleLabel(staff.role, roles)} tone="ink" />
        </PinnedHeader>
        <main id="main" tabIndex={-1} className="page-enter w-full max-w-7xl flex-1 px-4 pb-16 outline-none md:px-8">
          {children}
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}
