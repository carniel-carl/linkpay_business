"use client"

import { useRef, useState } from "react"
import { startStepUp } from "@/app/(dashboard)/settings/money-protection/actions"
import { CodeInput } from "@/components/auth/code-input"
import { FormError } from "@/components/common/form-error"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import type { ActionResult } from "@/lib/action-result"
import type { StepUpAction, StepUpChallenge, StepUpProof } from "@/lib/api/types"

/** These keep the dialog open: the person can fix the code or ask for a new one. */
const RETRY_HERE = new Set(["INVALID_CODE", "STEP_UP_EXPIRED", "STEP_UP_USED", "STEP_UP_MISMATCH"])
const NEEDS_NEW_CODE = new Set(["STEP_UP_EXPIRED", "STEP_UP_USED", "STEP_UP_MISMATCH"])

type Pending<T> = {
  action: StepUpAction
  request: Record<string, unknown>
  perform: (proof: StepUpProof) => Promise<ActionResult<T>>
  resolve: (result: ActionResult<T> | null) => void
}

/**
 * Step-up (transaction signing) for money-out buttons. `confirm` asks the backend for a code tied to exactly
 * this action and its details, shows what it confirms, then runs `perform` with the code. It resolves with
 * the action's result, or null if the person closed the dialog. Render `dialog` once in the component.
 *
 *   const stepUp = useStepUp()
 *   const result = await stepUp.confirm("transfer.create", body, (proof) => createTransfer(input, proof))
 */
export function useStepUp() {
  const [challenge, setChallenge] = useState<StepUpChallenge | null>(null)
  const [code, setCode] = useState("")
  const [error, setError] = useState<string>()
  const [needsNewCode, setNeedsNewCode] = useState(false)
  const [busy, setBusy] = useState<"confirm" | "resend" | null>(null)
  const pending = useRef<Pending<unknown> | null>(null)

  function finish(result: ActionResult<unknown> | null) {
    pending.current?.resolve(result)
    pending.current = null
    setChallenge(null)
    setCode("")
    setError(undefined)
    setNeedsNewCode(false)
  }

  async function begin() {
    const p = pending.current
    if (!p) return
    const started = await startStepUp(p.action, p.request)
    // Couldn't start (frozen, on hold, no permission...): the caller shows why.
    if (!started.ok) return finish(started)
    setChallenge(started.data)
    setCode("")
    setError(undefined)
    setNeedsNewCode(false)
  }

  function confirm<T>(action: StepUpAction, request: Record<string, unknown>, perform: (proof: StepUpProof) => Promise<ActionResult<T>>) {
    return new Promise<ActionResult<T> | null>((resolve) => {
      pending.current?.resolve(null)
      pending.current = { action, request, perform, resolve } as Pending<unknown>
      void begin()
    })
  }

  async function submit(value = code) {
    const p = pending.current
    if (!p || !challenge || value.length !== 6 || busy) return
    setBusy("confirm")
    setError(undefined)
    const result = await p.perform({ id: challenge.challengeId, code: value })
    setBusy(null)
    if (result.ok || !result.code || !RETRY_HERE.has(result.code)) return finish(result)
    setCode("")
    setNeedsNewCode(NEEDS_NEW_CODE.has(result.code))
    setError(
      result.code === "INVALID_CODE" && result.attemptsLeft !== undefined
        ? `That code is wrong. ${result.attemptsLeft === 0 ? "Send a new one." : `${result.attemptsLeft} ${result.attemptsLeft === 1 ? "try" : "tries"} left.`}`
        : result.error,
    )
    if (result.code === "INVALID_CODE" && result.attemptsLeft === 0) setNeedsNewCode(true)
  }

  async function resend() {
    setBusy("resend")
    await begin()
    setBusy(null)
  }

  const email = challenge?.method === "email"
  const dialog = (
    <Dialog open={!!challenge} onOpenChange={(open) => !open && !busy && finish(null)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Confirm with a code</DialogTitle>
          <DialogDescription>
            {email
              ? "We've emailed you a 6-digit code. The email says what it confirms, and it works for 5 minutes."
              : "Enter the 6-digit code from your authenticator app."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-5">
          <div className="grid gap-1 rounded-xl bg-muted px-4 py-3">
            <p className="text-xs text-muted-foreground">You&apos;re confirming</p>
            <p className="text-sm font-medium">{challenge?.summary}</p>
          </div>
          <div className="grid justify-items-center gap-2">
            <CodeInput
              value={code}
              onChange={setCode}
              onComplete={(value) => void submit(value)}
              disabled={busy !== null || needsNewCode}
              invalid={!!error}
            />
          </div>
          <FormError message={error} />
          <p className="text-xs text-muted-foreground">
            LinkPay staff will never ask for this code. If you didn&apos;t start this, close this window and freeze money out under Settings, Money protection.
          </p>
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          {email || needsNewCode ? (
            <Button type="button" variant="ghost" onClick={resend} disabled={busy !== null}>
              {busy === "resend" && <Spinner />}
              Send a new code
            </Button>
          ) : (
            <span />
          )}
          <Button type="button" onClick={() => submit()} disabled={code.length !== 6 || busy !== null || needsNewCode}>
            {busy === "confirm" && <Spinner />}
            Confirm
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )

  return { confirm, dialog }
}
