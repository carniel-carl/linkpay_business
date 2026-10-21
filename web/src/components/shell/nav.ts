import {
  ArrowLeftRight,
  History,
  House,
  PiggyBank,
  Landmark,
  ReceiptText,
  Settings,
  Store,
  UsersRound,
  type LucideIcon,
} from "lucide-react"
import type { Permission } from "@/lib/api/types"

export type NavItem = {
  href: string
  label: string
  icon: LucideIcon
  /** Built but not live yet: shows a "coming soon" empty state. */
  soon?: boolean
  /** Usable before the business is verified. */
  openBeforeApproval?: boolean
  /** Hidden from members whose role doesn't include this. */
  permission?: Permission
}

export const NAV: NavItem[] = [
  { href: "/dashboard", label: "Home", icon: House, openBeforeApproval: true },
  { href: "/accounts", label: "Accounts", icon: Landmark, permission: "accounts.view" },
  { href: "/transactions", label: "Transactions", icon: History, permission: "accounts.view" },
  { href: "/transfers", label: "Transfers", icon: ArrowLeftRight, permission: "accounts.view" },
  { href: "/invoices", label: "Invoices", icon: ReceiptText, permission: "accounts.view" },
  { href: "/savings", label: "Savings", icon: PiggyBank, permission: "accounts.view" },
  { href: "/branches", label: "Branches", icon: Store },
  { href: "/team", label: "Team", icon: UsersRound },
]

export const NAV_FOOTER: NavItem[] = [{ href: "/settings", label: "Settings", icon: Settings, openBeforeApproval: true }]
