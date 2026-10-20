"use client"

import { useEffect, useRef, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { loadAccounts } from "@/app/(dashboard)/accounts/actions"
import type { AccountsResult } from "@/lib/accounts"
import type { AccountSetupStatus } from "@/lib/api/types"

const POLL_MS = 5_000
const POLL_ATTEMPTS = 12 // about 60 seconds

/**
 * Holds the accounts state on the client. While the account is being set up it polls every 5s for
 * about a minute, then stops and keeps the message. `refresh` backs the retry buttons.
 */
export function useAccounts(initial: AccountsResult, setupStatus: AccountSetupStatus) {
  const router = useRouter()
  const [result, setResult] = useState(initial)
  const [pending, startTransition] = useTransition()
  const [attempts, setAttempts] = useState(0)
  const wasReady = useRef(initial.state === "ready")

  const failed = result.state === "setting_up" && setupStatus === "failed"
  const polling = result.state === "setting_up" && !failed && attempts < POLL_ATTEMPTS

  useEffect(() => {
    if (!polling) return
    const id = setTimeout(async () => {
      const next = await loadAccounts()
      setResult(next)
      setAttempts((n) => n + 1)
    }, POLL_MS)
    return () => clearTimeout(id)
  }, [polling, attempts])

  // Once the account appears, refresh server data (status badge, overview) for the rest of the page.
  useEffect(() => {
    if (result.state === "ready" && !wasReady.current) {
      wasReady.current = true
      router.refresh()
    }
  }, [result.state, router])

  function refresh() {
    startTransition(async () => setResult(await loadAccounts()))
  }

  return { result, failed, polling, refreshing: pending, refresh }
}
