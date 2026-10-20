import type { Metadata } from "next"
import { SecuritySettings } from "@/components/settings/security-settings"
import { getMe } from "@/lib/data"

export const metadata: Metadata = { title: "Security" }

export default async function SecurityPage() {
  const user = await getMe()
  return <SecuritySettings enabled={!!user.twoFactor?.enabled} method={user.twoFactor?.method ?? null} email={user.email} />
}
