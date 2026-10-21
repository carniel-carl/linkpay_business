import {
  ArrowLeftRight,
  CircleHelp,
  History,
  House,
  PiggyBank,
  Landmark,
  Link2,
  ReceiptText,
  Settings,
  ShieldCheck,
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

export type NavGroup = {
  /** Groups without a label sit at the top with no heading. */
  label?: string
  items: NavItem[]
}

export const NAV: NavGroup[] = [
  { items: [{ href: "/dashboard", label: "Home", icon: House, openBeforeApproval: true }] },
  {
    label: "Banking",
    items: [
      { href: "/accounts", label: "Accounts", icon: Landmark, permission: "accounts.view" },
      { href: "/transactions", label: "Transactions", icon: History, permission: "accounts.view" },
      { href: "/transfers", label: "Transfers", icon: ArrowLeftRight, permission: "accounts.view" },
      { href: "/approvals", label: "Fund approvals", icon: ShieldCheck, permission: "accounts.view" },
      { href: "/invoices", label: "Invoices", icon: ReceiptText, permission: "accounts.view" },
      { href: "/payment-links", label: "Payment links", icon: Link2, permission: "accounts.view" },
      { href: "/savings", label: "Savings", icon: PiggyBank, permission: "accounts.view" },
    ],
  },
  {
    label: "Business",
    items: [
      { href: "/branches", label: "Branches", icon: Store },
      { href: "/team", label: "Team", icon: UsersRound },
    ],
  },
]

export const NAV_FOOTER: NavItem[] = [
  { href: "/help", label: "Help", icon: CircleHelp, openBeforeApproval: true },
  { href: "/settings", label: "Settings", icon: Settings, openBeforeApproval: true },
]
