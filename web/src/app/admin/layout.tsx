import type { Metadata } from "next"
import { cookies } from "next/headers"
import { notFound } from "next/navigation"
import { AdminSidebar } from "@/components/admin/admin-sidebar"
import { PinnedHeader } from "@/components/shell/pinned-header"
import { UserMenu } from "@/components/shell/user-menu"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { getAdminSummary, getMe, getOverview } from "@/lib/data"

export const metadata: Metadata = { title: { default: "Review queue", template: "%s · LinkPay Staff" } }

export default async function AdminLayout({ children }: LayoutProps<"/admin">) {
  const user = await getMe()
  // Hide the admin area entirely from everyone else.
  if (user.role !== "admin") notFound()
  const [summary, overview, jar] = await Promise.all([getAdminSummary(), getOverview(), cookies()])

  return (
    <SidebarProvider defaultOpen={jar.get("sidebar_state")?.value !== "false"}>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-full focus:bg-pop focus:px-4 focus:py-2 focus:text-pop-foreground"
      >
        Skip to content
      </a>
      <AdminSidebar summary={summary} hasBusiness={!!overview} />
      {/* Same framed sheet as the business dashboard; the header is fixed (see PinnedHeader). */}
      <SidebarInset
        data-band
        className="overflow-x-clip bg-[linear-gradient(to_bottom,var(--brand-surface)_0,var(--brand-surface)_14rem,var(--background)_14rem)] md:peer-data-[variant=inset]:rounded-2xl"
      >
        <PinnedHeader>
          <SidebarTrigger className="-ml-1.5 text-brand-surface-muted hover:bg-brand-surface-foreground/10 hover:text-brand-surface-foreground" />
          <p className="min-w-0 flex-1 truncate text-sm text-brand-surface-muted">Staff console</p>
          <UserMenu user={user} tone="ink" showSettings={!!overview} />
        </PinnedHeader>
        <main id="main" tabIndex={-1} className="page-enter w-full max-w-7xl flex-1 px-4 pb-16 outline-none md:px-8">
          {children}
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}
