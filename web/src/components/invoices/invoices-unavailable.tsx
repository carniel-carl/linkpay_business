"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { ProviderDownNotice } from "@/components/accounts/account-notices"

export function InvoicesUnavailable() {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  return (
    <ProviderDownNotice
      title="We can't load your invoices right now"
      refreshing={pending}
      onRetry={() => startTransition(() => router.refresh())}
    />
  )
}
