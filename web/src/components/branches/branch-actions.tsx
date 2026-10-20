"use client"

import { useEffect, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { ArrowRight } from "lucide-react"
import { selectBranch } from "@/app/(dashboard)/branches/actions"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"

/** Makes this branch the one the dashboard shows (same as picking it in the sidebar switcher). */
export function ViewBranchButton({ branchId, name }: { branchId: string; name: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={pending}
      aria-label={`Show ${name} across the dashboard`}
      onClick={() =>
        startTransition(async () => {
          await selectBranch(branchId)
          router.push("/accounts")
        })
      }
    >
      {pending ? <Spinner /> : null}
      View this branch
      {!pending && <ArrowRight data-icon="inline-end" aria-hidden />}
    </Button>
  )
}

const POLL_MS = 5_000
const POLL_ATTEMPTS = 12 // about a minute, like the accounts screen

/** While any branch account is still being set up, re-renders the page every few seconds for a minute. */
export function RefreshWhileSettingUp({ active }: { active: boolean }) {
  const router = useRouter()
  const [attempts, setAttempts] = useState(0)

  useEffect(() => {
    if (!active || attempts >= POLL_ATTEMPTS) return
    const id = setTimeout(() => {
      router.refresh()
      setAttempts((n) => n + 1)
    }, POLL_MS)
    return () => clearTimeout(id)
  }, [active, attempts, router])

  return null
}
