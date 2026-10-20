"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { ProviderDownNotice } from "@/components/accounts/account-notices"

/** The list couldn't load: same calm notice as the Accounts page, retried with a refresh. */
export function TransactionsUnavailable() {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  return (
    <ProviderDownNotice
      title="We can't load your transactions right now"
      refreshing={pending}
      onRetry={() => startTransition(() => router.refresh())}
    />
  )
}
