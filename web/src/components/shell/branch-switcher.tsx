"use client"

import { useOptimistic, useTransition } from "react"
import Link from "next/link"
import { ArrowRight, Building2, Check, ChevronsUpDown, Layers, Lock, Plus, Store } from "lucide-react"
import { selectBranch } from "@/app/(dashboard)/branches/actions"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "@/components/ui/sidebar"
import { Spinner } from "@/components/ui/spinner"
import { initials } from "@/lib/format"

export type SwitcherBranch = { id: string; name: string; isHeadOffice: boolean; detail?: string }

/**
 * Branch switcher at the top of the sidebar. The choice is kept in a cookie (see lib/branches.ts)
 * and narrows Home and Accounts to that branch; "All branches" shows everything.
 *
 * Before approval there are no branches yet, so it shows the head office as a placeholder. Staff
 * limited to one branch see just that branch, with nothing to switch.
 */
export function BranchSwitcher({
  businessName,
  headOfficeCity,
  approved,
  branches,
  selectedId,
  canManage,
}: {
  businessName: string
  headOfficeCity?: string
  approved: boolean
  branches: SwitcherBranch[]
  selectedId: string | null
  /** Can add and edit branches (`branches.manage`); otherwise the link only views them. */
  canManage: boolean
}) {
  const { isMobile, setOpenMobile } = useSidebar()
  const [pending, startTransition] = useTransition()
  // The checkmark and label move at once; the server re-render follows.
  const [current, setCurrent] = useOptimistic(selectedId)

  const list: SwitcherBranch[] = branches.length
    ? branches
    : [{ id: "head-office", name: "Head office", isHeadOffice: true, detail: headOfficeCity }]
  const canSwitch = approved && branches.length > 1
  const currentName = canSwitch
    ? (list.find((b) => b.id === current)?.name ?? "All branches")
    : (branches[0]?.name ?? "Head office")

  function choose(id: string | null) {
    if (!canSwitch || id === current) return
    startTransition(async () => {
      setCurrent(id)
      await selectBranch(id)
    })
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="h-14 gap-3 rounded-xl px-2 data-[state=open]:bg-sidebar-accent group-data-[collapsible=icon]:size-10! group-data-[collapsible=icon]:p-1!"
            >
              <span className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-sidebar-primary font-display text-sm font-bold text-sidebar-primary-foreground group-data-[collapsible=icon]:size-8">
                {initials(businessName)}
              </span>
              <span className="grid min-w-0 flex-1 leading-tight">
                <span className="truncate font-display text-[15px] font-semibold tracking-[-0.01em] text-sidebar-accent-foreground">
                  {businessName}
                </span>
                <span className="flex items-center gap-1.5 truncate text-xs text-sidebar-foreground/70">
                  {currentName}
                  {pending && <Spinner className="size-3" />}
                </span>
              </span>
              <ChevronsUpDown className="ml-auto size-4 text-sidebar-foreground/60" aria-hidden />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--radix-dropdown-menu-trigger-width) min-w-64 rounded-xl"
            align="start"
            side={isMobile ? "bottom" : "right"}
            sideOffset={6}
          >
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Show</DropdownMenuLabel>
            {canSwitch && (
              <Option
                icon={Layers}
                name="All branches"
                detail={`${branches.length} ${branches.length === 1 ? "location" : "locations"}`}
                active={current === null}
                onSelect={() => choose(null)}
              />
            )}
            {list.map((b) => (
              <Option
                key={b.id}
                icon={b.isHeadOffice ? Building2 : Store}
                name={b.name}
                detail={b.detail}
                active={canSwitch ? b.id === current : true}
                onSelect={() => choose(b.id)}
              />
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild className="gap-3 py-2">
              <Link href="/branches" onClick={() => setOpenMobile(false)}>
                <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-dashed">
                  {approved && !canManage ? <ArrowRight className="size-4" aria-hidden /> : <Plus className="size-4" aria-hidden />}
                </span>
                <span className="grid flex-1">
                  <span className="text-sm font-medium">
                    {!approved ? "Add a branch" : canManage ? "Manage branches" : "View branches"}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {!approved
                      ? "After your business is verified"
                      : canManage
                        ? "Add a location or edit details"
                        : "Addresses and account numbers"}
                  </span>
                </span>
                {!approved && <Lock className="size-3.5 text-muted-foreground" aria-hidden />}
              </Link>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}

function Option({
  icon: Icon,
  name,
  detail,
  active,
  onSelect,
}: {
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>
  name: string
  detail?: string
  active: boolean
  onSelect: () => void
}) {
  return (
    <DropdownMenuItem className="gap-3 py-2" onSelect={onSelect}>
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted">
        <Icon className="size-4" aria-hidden />
      </span>
      <span className="grid min-w-0 flex-1">
        <span className="truncate text-sm font-medium">{name}</span>
        {detail && <span className="truncate text-xs text-muted-foreground">{detail}</span>}
      </span>
      {active && <Check className="size-4 text-primary" aria-label="Showing now" />}
    </DropdownMenuItem>
  )
}
