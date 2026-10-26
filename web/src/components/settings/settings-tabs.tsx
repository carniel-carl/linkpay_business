"use client"

import { usePathname } from "next/navigation"
import { NavTabs } from "@/components/common/nav-tabs"

const TABS = [
  { key: "/settings", href: "/settings", label: "Profile" },
  { key: "/settings/security", href: "/settings/security", label: "Security" },
]

const MONEY_PROTECTION = { key: "/settings/money-protection", href: "/settings/money-protection", label: "Money protection" }
const BRANDING = { key: "/settings/branding", href: "/settings/branding", label: "Invoice branding" }

/** Money protection and invoice branding are the business's: shown once it's verified, branding to members who manage invoices. */
export function SettingsTabs({ showBranding = false, showMoneyProtection = false }: { showBranding?: boolean; showMoneyProtection?: boolean }) {
  const items = [...TABS, ...(showMoneyProtection ? [MONEY_PROTECTION] : []), ...(showBranding ? [BRANDING] : [])]
  return <NavTabs label="Settings sections" items={items} current={usePathname()} />
}
