"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { Lock, ShieldCheck } from "lucide-react"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
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
import type { MembershipSummary, Permission } from "@/lib/api/types"
import { BranchSwitcher, type SwitcherBranch } from "./branch-switcher"
import { BusinessSwitcher } from "./business-switcher"
import { NAV, NAV_FOOTER, type NavItem } from "./nav"
import { Logo } from "@/components/brand/logo"

type Props = {
  approved: boolean
  isAdmin: boolean
  businessName: string
  headOfficeCity?: string
  branches: SwitcherBranch[]
  selectedBranchId: string | null
  canManageBranches: boolean
  businessId: string
  /** Shown as a business switcher only when there's more than one. */
  memberships: MembershipSummary[]
  /** The member's permissions; nav items needing others are hidden. Absent before the business exists. */
  permissions?: Permission[]
}

export function AppSidebar({
  approved,
  isAdmin,
  businessName,
  headOfficeCity,
  branches,
  selectedBranchId,
  canManageBranches,
  businessId,
  memberships,
  permissions,
}: Props) {
  // Owners of an unverified business have no membership details yet; show everything (locked).
  const visible = NAV.filter((item) => !item.permission || !permissions || permissions.includes(item.permission))
  return (
    <Sidebar collapsible="icon" variant="inset">
      <SidebarHeader className="gap-1.5 px-2 pt-3">
        {memberships.length > 1 && <BusinessSwitcher memberships={memberships} currentId={businessId} />}
        <BranchSwitcher
          canManage={canManageBranches}
          businessName={businessName}
          headOfficeCity={headOfficeCity}
          approved={approved}
          branches={branches}
          selectedId={selectedBranchId}
        />
      </SidebarHeader>
      <SidebarContent className="pt-2">
        <SidebarGroup>
          <SidebarGroupLabel className="text-sidebar-foreground/85">Banking</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu className="gap-0.5">
              {visible.map((item) => (
                <NavLink key={item.href} item={item} approved={approved} />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        {isAdmin && (
          <SidebarGroup>
            <SidebarGroupLabel className="text-sidebar-foreground/85">Staff</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <NavLink
                  item={{ href: "/admin", label: "Review queue", icon: ShieldCheck, openBeforeApproval: true }}
                  approved={approved}
                />
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>
      <SidebarFooter className="gap-3 pb-3">
        <SidebarMenu>
          {NAV_FOOTER.map((item) => (
            <NavLink key={item.href} item={item} approved={approved} />
          ))}
        </SidebarMenu>
        <div className="px-2 group-data-[collapsible=icon]:hidden">
          <Logo inverse className="text-sm opacity-80" />
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}

function NavLink({ item, approved }: { item: NavItem; approved: boolean }) {
  const pathname = usePathname()
  const { setOpenMobile } = useSidebar()
  const active = pathname === item.href || pathname.startsWith(`${item.href}/`)
  const locked = !approved && !item.openBeforeApproval
  const Icon = item.icon

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={active}
        tooltip={item.label}
        className="h-10 rounded-xl px-3 text-[14px] text-sidebar-foreground transition-colors duration-200 hover:text-sidebar-accent-foreground data-[active=true]:font-medium data-[active=true]:[&>svg]:text-sidebar-primary"
      >
        <Link href={item.href} onClick={() => setOpenMobile(false)} aria-current={active ? "page" : undefined}>
          <Icon aria-hidden />
          <span>{item.label}</span>
        </Link>
      </SidebarMenuButton>
      {locked ? (
        <SidebarMenuBadge className="top-2.5!" aria-label="Locked until your business is verified">
          <Lock className="size-3.5 text-sidebar-foreground/70" aria-hidden />
        </SidebarMenuBadge>
      ) : (
        item.soon && (
          <SidebarMenuBadge className="top-2.5! text-[11px] font-normal text-sidebar-foreground/85">Soon</SidebarMenuBadge>
        )
      )}
    </SidebarMenuItem>
  )
}
