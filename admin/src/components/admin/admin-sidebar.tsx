"use client"

import Link from "next/link"
import { usePathname, useSearchParams } from "next/navigation"
import {
  ArrowLeftRight,
  Building2,
  ClipboardCheck,
  MessageSquareWarning,
  ScrollText,
  ShieldAlert,
  ShieldCheck,
  TriangleAlert,
  UsersRound,
  type LucideIcon,
} from "lucide-react"
import { Logo } from "@/components/brand/logo"
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar"
import type { AdminSummary, SecuritySummary } from "@/lib/api/types"
import { cn } from "@/lib/utils"

type Item = {
  href: string
  label: string
  icon: LucideIcon
  count?: number
  /** Spoken after the count, e.g. "12 waiting". */
  countLabel?: string
  /** Draws attention to the count (something needs fixing). */
  alert?: boolean
  isActive: (pathname: string, params: URLSearchParams) => boolean
}

/** What the signed-in staff member's role can open (see lib/permissions.ts). */
export type NavAccess = { staff: boolean; activity: boolean; compliance: boolean; security: boolean }

/** Staff console navigation. Counts come from GET /api/admin/summary; each group shows only what the role can open. */
export function AdminSidebar({ summary, security, access }: { summary: AdminSummary | null; security: SecuritySummary | null; access: NavAccess }) {
  return (
    <Sidebar collapsible="icon" variant="inset" aria-label="Staff console">
      <SidebarHeader className="px-2 pt-3">
        <Link
          href="/"
          className="flex h-12 items-center gap-2 rounded-xl px-1.5 outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
        >
          <Logo inverse showProduct={false} className="[&>span:last-child]:group-data-[collapsible=icon]:hidden" />
          <span className="rounded-md border border-sidebar-foreground/20 px-1.5 py-px text-[11px] text-sidebar-foreground/85 group-data-[collapsible=icon]:hidden">
            Staff
          </span>
        </Link>
      </SidebarHeader>
      <SidebarContent className="pt-2">
        {summary && <BusinessNav summary={summary} />}
        <MonitoringNav summary={summary} security={security} access={access} />
        {access.staff && <NavGroup label="Team" items={TEAM} />}
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  )
}

const TEAM: Item[] = [{ href: "/staff", label: "Staff", icon: UsersRound, isActive: (p) => p === "/staff" }]

function BusinessNav({ summary }: { summary: AdminSummary }) {
  const review: Item[] = [
    {
      href: "/",
      label: "Review queue",
      icon: ClipboardCheck,
      count: summary.counts.submitted,
      countLabel: "waiting",
      isActive: (p) => p === "/",
    },
    {
      href: "/businesses?status=changes_requested",
      label: "With owners",
      icon: MessageSquareWarning,
      count: summary.counts.changes_requested,
      countLabel: "sent back for changes",
      isActive: (p, q) => p === "/businesses" && q.get("status") === "changes_requested",
    },
  ]
  const directory: Item[] = [
    {
      href: "/businesses",
      label: "All businesses",
      icon: Building2,
      count: summary.total,
      countLabel: "in total",
      isActive: (p, q) =>
        (p === "/businesses" && q.get("status") !== "changes_requested" && q.get("account") !== "failed") ||
        p.startsWith("/businesses/"),
    },
    {
      href: "/businesses?status=approved&account=failed",
      label: "Account setup failed",
      icon: TriangleAlert,
      count: summary.accountSetupFailed,
      countLabel: "need a retry",
      alert: summary.accountSetupFailed > 0,
      isActive: (p, q) => p === "/businesses" && q.get("account") === "failed",
    },
  ]

  return (
    <>
      <NavGroup label="Review" items={review} />
      <NavGroup label="Directory" items={directory} />
    </>
  )
}

function MonitoringNav({ summary, security, access }: { summary: AdminSummary | null; security: SecuritySummary | null; access: NavAccess }) {
  const flagged = summary?.compliance.flagged ?? 0
  const waiting = security?.pending ?? 0
  const items: Item[] = [
    ...(access.security
      ? [
          {
            href: "/security-reviews",
            label: "Security reviews",
            icon: ShieldCheck,
            count: waiting,
            countLabel: "waiting for review",
            alert: waiting > 0,
            isActive: (p: string) => p.startsWith("/security-reviews"),
          },
        ]
      : []),
    ...(access.compliance
      ? [
          {
            href: "/compliance",
            label: "Compliance",
            icon: ShieldAlert,
            count: flagged,
            countLabel: flagged === 1 ? "business flagged" : "businesses flagged",
            alert: flagged > 0,
            isActive: (p: string) => p === "/compliance",
          },
        ]
      : []),
    ...(access.activity
      ? [{ href: "/payments", label: "Payments", icon: ArrowLeftRight, isActive: (p: string) => p === "/payments" }]
      : []),
    ...(access.compliance
      ? [{ href: "/audit", label: "Audit log", icon: ScrollText, isActive: (p: string) => p === "/audit" }]
      : []),
  ]
  return items.length ? <NavGroup label="Monitoring" items={items} /> : null
}

function NavGroup({ label, items }: { label: string; items: Item[] }) {
  return (
    <SidebarGroup>
      <SidebarGroupLabel className="text-sidebar-foreground/85">{label}</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu className="gap-0.5">
          {items.map((item) => (
            <NavLink key={item.href} item={item} />
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}

function NavLink({ item }: { item: Item }) {
  const pathname = usePathname()
  const params = useSearchParams()
  const { setOpenMobile } = useSidebar()
  const active = item.isActive(pathname, params)
  const Icon = item.icon

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={active}
        tooltip={item.count ? `${item.label} (${item.count})` : item.label}
        className="h-10 rounded-xl px-3 text-[14px] text-sidebar-foreground transition-colors duration-200 hover:text-sidebar-accent-foreground data-[active=true]:font-medium data-[active=true]:[&>svg]:text-sidebar-primary"
      >
        <Link href={item.href} onClick={() => setOpenMobile(false)} aria-current={active ? "page" : undefined}>
          <Icon aria-hidden />
          <span>{item.label}</span>
          {!!item.count && (
            <span className="sr-only">
              , {item.count} {item.countLabel}
            </span>
          )}
        </Link>
      </SidebarMenuButton>
      {!!item.count && (
        <SidebarMenuBadge
          aria-hidden
          className={cn(
            "top-2.5! figure rounded-md",
            item.alert ? "bg-destructive-subtle text-destructive" : "text-sidebar-foreground/85",
          )}
        >
          {item.count}
        </SidebarMenuBadge>
      )}
    </SidebarMenuItem>
  )
}
