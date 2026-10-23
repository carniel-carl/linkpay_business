"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { ProviderDownNotice } from "@/components/accounts/account-notices"

/** A list that couldn't load: the same calm notice as Transactions, retried with a refresh. */
export function PayoutsUnavailable({ what }: { what: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  return <ProviderDownNotice title={`We can't load your ${what} right now`} refreshing={pending} onRetry={() => startTransition(() => router.refresh())} />
}
