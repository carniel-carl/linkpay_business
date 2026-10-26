"use client"

import { useState } from "react"
import { CircleCheck } from "lucide-react"
import { FormError } from "@/components/common/form-error"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { submitSecurityReport } from "./actions"

/** The confirm step: opening the link alone changes nothing, so email scanners can't trigger it. */
export function ReportButton({ token, supportEmail }: { token: string; supportEmail: string }) {
  const [state, setState] = useState<"idle" | "busy" | "done">("idle")
  const [error, setError] = useState<string>()

  async function report() {
    setState("busy")
    setError(undefined)
    const result = await submitSecurityReport(token)
    if (result.ok || result.code === "REPORT_USED") return setState("done")
    setError(result.error)
    setState("idle")
  }

  if (state === "done") {
    return (
      <div className="grid gap-3" role="status">
        <p className="flex items-center gap-2 font-medium">
          <CircleCheck className="size-5 text-success" aria-hidden />
          Stopped
        </p>
        <p className="text-sm text-muted-foreground">
          We&apos;ve stopped the change, signed out whoever made it and frozen money leaving the business. We&apos;ll contact you on a
          number from your verification. Change your email password now, and write to{" "}
          <a href={`mailto:${supportEmail}`} className="font-medium text-foreground underline underline-offset-4">
            {supportEmail}
          </a>{" "}
          if you need us sooner.
        </p>
      </div>
    )
  }
  return (
    <div className="grid gap-4">
      <FormError message={error} />
      <Button variant="destructive" size="lg" onClick={report} disabled={state === "busy"}>
        {state === "busy" && <Spinner />}
        This wasn&apos;t me, stop it
      </Button>
      <p className="text-xs text-muted-foreground">If this was you or someone on your team, close this page. Nothing changes.</p>
    </div>
  )
}
