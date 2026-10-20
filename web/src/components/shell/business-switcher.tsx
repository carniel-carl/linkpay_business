"use client"

import { useOptimistic, useTransition } from "react"
import { ArrowLeftRight, Check } from "lucide-react"
import { selectBusiness } from "@/app/(dashboard)/business-actions"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "@/components/ui/sidebar"
import { Spinner } from "@/components/ui/spinner"
import type { MembershipSummary } from "@/lib/api/types"
import { initials } from "@/lib/format"
import { roleLabel } from "@/lib/permissions"

/**
 * Sits above the branch switcher when the user belongs to more than one business. The choice is kept
 * in the `lp_business` cookie and sent as X-Business-Id; switching also resets the branch choice.
 */
export function BusinessSwitcher({ memberships, currentId }: { memberships: MembershipSummary[]; currentId: string }) {
  const { isMobile, setOpenMobile } = useSidebar()
  const [pending, startTransition] = useTransition()
  const [current, setCurrent] = useOptimistic(currentId)

  function choose(id: string) {
    if (id === current) return
    startTransition(async () => {
      setCurrent(id)
      await selectBusiness(id)
      setOpenMobile(false)
    })
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              tooltip="Switch business"
              className="h-9 rounded-xl px-2.5 text-[13px] text-sidebar-foreground data-[state=open]:bg-sidebar-accent"
            >
              {pending ? <Spinner className="size-4" /> : <ArrowLeftRight aria-hidden />}
              <span className="flex-1 truncate">Switch business</span>
              <span className="grid h-5 min-w-5 place-items-center rounded-md bg-sidebar-accent px-1.5 text-[11px] font-medium text-sidebar-accent-foreground figure group-data-[collapsible=icon]:hidden">
                {memberships.length}
              </span>
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--radix-dropdown-menu-trigger-width) min-w-64 rounded-xl"
            align="start"
            side={isMobile ? "bottom" : "right"}
            sideOffset={6}
          >
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Your businesses</DropdownMenuLabel>
            {memberships.map((m) => (
              <DropdownMenuItem key={m.business._id} className="gap-3 py-2" onSelect={() => choose(m.business._id)}>
                <span className="grid size-8 shrink-0 place-items-center rounded-[10px] bg-muted font-display text-xs font-bold">
                  {initials(m.business.name)}
                </span>
                <span className="grid min-w-0 flex-1">
                  <span className="truncate text-sm font-medium">{m.business.name}</span>
                  <span className="truncate text-xs text-muted-foreground">{m.roleLabel ?? roleLabel(m.role)}</span>
                </span>
                {m.business._id === current && <Check className="size-4 text-primary" aria-label="Current business" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
