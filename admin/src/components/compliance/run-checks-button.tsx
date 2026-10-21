"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { RefreshCw } from "lucide-react"
import { toast } from "sonner"
import { runChecks } from "@/app/(console)/compliance/actions"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"

/** Runs the automatic risk rules now instead of waiting for the next five-minute run. */
export function RunChecksButton() {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  return (
    <Button
      variant="outline"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await runChecks()
          if (!result.ok) return void toast.error(result.error)
          const { raised } = result.data
          toast.success(raised ? `Checks done. ${raised} new ${raised === 1 ? "flag" : "flags"} raised.` : "Checks done. Nothing new to flag.")
          router.refresh()
        })
      }
    >
      {pending ? <Spinner /> : <RefreshCw data-icon="inline-start" aria-hidden />}
      Run checks now
    </Button>
  )
}
