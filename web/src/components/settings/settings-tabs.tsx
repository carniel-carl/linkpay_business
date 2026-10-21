"use client"

import { usePathname } from "next/navigation"
import { NavTabs } from "@/components/common/nav-tabs"

const TABS = [
  { key: "/settings", href: "/settings", label: "Profile" },
  { key: "/settings/security", href: "/settings/security", label: "Security" },
]

const BRANDING = { key: "/settings/branding", href: "/settings/branding", label: "Invoice branding" }

/** Invoice branding is the business's, so only members who manage invoices see it. */
export function SettingsTabs({ showBranding = false }: { showBranding?: boolean }) {
  return <NavTabs label="Settings sections" items={showBranding ? [...TABS, BRANDING] : TABS} current={usePathname()} />
}
