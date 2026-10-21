"use client"

import { useEffect, useState, useTransition } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import type { ActionResult } from "@/lib/action-result"

const COOLDOWN = 60

/**
 * "Resend code" with the backend's 60-second cooldown. Starts counting down on mount when a
 * code was just sent, and again after every successful resend.
 */
export function ResendButton({
  onResend,
  startCoolingDown = true,
}: {
  onResend: () => Promise<ActionResult>
  startCoolingDown?: boolean
}) {
  const [secondsLeft, setSecondsLeft] = useState(startCoolingDown ? COOLDOWN : 0)
  const [pending, startTransition] = useTransition()

  useEffect(() => {
    if (secondsLeft <= 0) return
    const id = setTimeout(() => setSecondsLeft((s) => s - 1), 1000)
    return () => clearTimeout(id)
  }, [secondsLeft])

  function resend() {
    startTransition(async () => {
      const result = await onResend()
      if (result.ok) {
        toast.success("We've sent a new code.")
        setSecondsLeft(COOLDOWN)
      } else {
        toast.error(result.error)
        if (result.code === "OTP_COOLDOWN") setSecondsLeft(COOLDOWN)
      }
    })
  }

  const waiting = secondsLeft > 0
  return (
    <p className="text-sm text-muted-foreground">
      Didn&apos;t get it?{" "}
      <Button
        type="button"
        variant="link"
        className="h-auto p-0 figure"
        disabled={waiting || pending}
        onClick={resend}
        aria-live="polite"
      >
        {pending ? "Sending…" : waiting ? `Resend in ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, "0")}` : "Resend code"}
      </Button>
    </p>
  )
}
