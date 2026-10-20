"use client"

import { usePathname } from "next/navigation"
import { NavTabs } from "@/components/common/nav-tabs"

const TABS = [
  { key: "/settings", href: "/settings", label: "Profile" },
  { key: "/settings/security", href: "/settings/security", label: "Security" },
]

export function SettingsTabs() {
  return <NavTabs label="Settings sections" items={TABS} current={usePathname()} />
}
