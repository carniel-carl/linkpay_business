"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { FEW_RECOVERY_CODES, RECOVERY_NOTICE_COOKIE } from "@/lib/recovery-codes"

/**
 * After a sign-in with a recovery code, the sign-in action leaves a short-lived cookie with how many are left.
 * This reads it once, deletes it and says so in a toast that stays until it's closed, with a way to get new codes.
 */
export function RecoveryCodeNotice() {
  const router = useRouter()

  useEffect(() => {
    const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${RECOVERY_NOTICE_COOKIE}=(\\d+)`))
    if (!match) return
    document.cookie = `${RECOVERY_NOTICE_COOKIE}=; path=/; max-age=0; samesite=lax`
    const left = Number(match[1])
    toast.warning(`You used a recovery code. ${left} left.`, {
      id: RECOVERY_NOTICE_COOKIE,
      description:
        left === 0
          ? "You have none left. Get new codes now, so you can still sign in if you lose your phone."
          : left <= FEW_RECOVERY_CODES
            ? "Get new codes soon, so you don't run out."
            : "Each code works once. You can get new codes any time in Security settings.",
      duration: Infinity,
      closeButton: true,
      action: { label: "Get new codes", onClick: () => router.push("/settings/security#recovery-codes") },
    })
  }, [router])

  return null
}
