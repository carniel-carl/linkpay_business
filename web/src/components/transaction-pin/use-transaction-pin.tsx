"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Lock } from "lucide-react"
import { getTransactionPinState } from "@/app/(dashboard)/transaction-pin-actions"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldError, FieldLabel } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import type { ActionResult } from "@/lib/action-result"
import { isPinError, PIN_LENGTH, unlocksAt, wrongPinMessage } from "@/lib/transaction-pin"
import { NoPasswordNotice, ResetPinForm, SetPinForm } from "./pin-forms"
import { PinInput } from "./pin-input"

export type PinConfirmation<T> = {
  /** Finishes "Enter your transaction PIN to …", e.g. "send ₦25,000.00 to Ada Obi". */
  purpose: string
  /** The confirm button, e.g. "Send ₦25,000.00". */
  confirmLabel: string
  /**
   * Calls the Server Action with the PIN. After a wrong PIN it runs again with the next one, so it must send
   * the same request each time: take the Idempotency-Key before calling confirm (useIdempotencyKey's key comes
   * from the request details, which never include the PIN).
   */
  run: (pin: string) => Promise<ActionResult<T>>
}

type Request = PinConfirmation<unknown> & { id: number }
type Finish = (result: ActionResult<unknown> | null) => void

/**
 * "Confirm with your PIN" for the actions the backend guards with the transaction PIN
 * (docs/briefs/transaction-pin.md). `confirm` opens a dialog over the review step and resolves with the
 * action's answer once it's no longer about the PIN: success, or an error for the caller to show as before
 * (not enough money, say). It resolves `null` when the person closes the dialog first.
 *
 * Wrong, missing and locked PINs are handled in the dialog. Someone without a PIN sets one there (password,
 * then the PIN twice) and the action carries on with it; a forgotten or locked PIN can be reset there too.
 * Render `dialog` anywhere in the component.
 */
export function useTransactionPin() {
  const [request, setRequest] = useState<Request | null>(null)
  const waiting = useRef<Finish | null>(null)
  const seq = useRef(0)

  const confirm = useCallback(
    <T,>(options: PinConfirmation<T>) =>
      new Promise<ActionResult<T> | null>((resolve) => {
        waiting.current?.(null)
        waiting.current = resolve as Finish
        seq.current += 1
        setRequest({ ...(options as PinConfirmation<unknown>), id: seq.current })
      }),
    [],
  )

  const finish = useCallback<Finish>((result) => {
    const resolve = waiting.current
    waiting.current = null
    setRequest(null)
    resolve?.(result)
  }, [])

  return { confirm, dialog: <TransactionPinDialog request={request} onFinish={finish} /> }
}

function TransactionPinDialog({ request, onFinish }: { request: Request | null; onFinish: Finish }) {
  // While the action runs the dialog can't be closed: its answer (money may have moved) must reach the caller.
  const [busy, setBusy] = useState(false)
  const done: Finish = (result) => {
    setBusy(false)
    onFinish(result)
  }
  return (
    <Dialog open={!!request} onOpenChange={(open) => !open && !busy && done(null)}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md" showCloseButton={!busy}>
        {request && <PinFlow key={request.id} request={request} onFinish={done} onBusyChange={setBusy} />}
      </DialogContent>
    </Dialog>
  )
}

type Step =
  | { name: "loading" }
  | { name: "enter"; error?: string; notice?: string }
  | { name: "setup" }
  | { name: "no-password" }
  | { name: "locked"; until: string | null }

type Mode = Step | { name: "reset"; back: Step }

const UNREACHABLE = "We couldn't reach LinkPay. Check your connection and try again."

function PinFlow({ request, onFinish, onBusyChange }: { request: Request; onFinish: Finish; onBusyChange: (busy: boolean) => void }) {
  const [mode, setMode] = useState<Mode>({ name: "loading" })
  const [hasPassword, setHasPassword] = useState<boolean | null>(null)
  // The PIN being typed. Emptied the moment it's sent, so it never outlives an attempt.
  const [pin, setPin] = useState("")
  const [busy, setBusy] = useState(false)
  // Closing the dialog while a PIN is being set or reset mustn't then run the action.
  const open = useRef(true)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    open.current = true
    return () => {
      open.current = false
    }
  }, [])

  // Which step to start on. If this can't be checked, ask for the PIN: the action's answer corrects it.
  useEffect(() => {
    let stale = false
    getTransactionPinState().then(
      (r) => {
        if (stale) return
        if (!r.ok) return setMode({ name: "enter" })
        setHasPassword(r.data.hasPassword)
        if (r.data.locked) setMode({ name: "locked", until: r.data.lockedUntil })
        else if (r.data.isSet) setMode({ name: "enter" })
        else setMode(r.data.hasPassword ? { name: "setup" } : { name: "no-password" })
      },
      () => !stale && setMode({ name: "enter" }),
    )
    return () => {
      stale = true
    }
  }, [])

  // Back in the PIN field after a wrong try (it was disabled while the PIN was checked).
  const asking = mode.name === "enter" && !busy
  useEffect(() => {
    if (asking) input.current?.focus()
  }, [asking, mode])

  // A lock that ends while the dialog is open goes back to asking for the PIN.
  const lockedUntil = mode.name === "locked" ? mode.until : null
  useEffect(() => {
    if (!lockedUntil) return
    const ms = new Date(lockedUntil).getTime() - Date.now()
    if (!(ms < 2 ** 31 - 1)) return
    const id = setTimeout(() => setMode({ name: "enter", notice: "Your PIN is unlocked. Enter it to carry on." }), Math.max(0, ms) + 1000)
    return () => clearTimeout(id)
  }, [lockedUntil])

  /** One try with this PIN. Answers about the PIN stay here; anything else goes back to the caller. */
  async function attempt(value: string) {
    if (!open.current) return
    setBusy(true)
    onBusyChange(true)
    let result: ActionResult<unknown> | undefined
    try {
      result = await request.run(value)
    } catch {
      // The request may or may not have gone through. Trying again sends the same Idempotency-Key.
      setBusy(false)
      onBusyChange(false)
      return setMode({ name: "enter", error: UNREACHABLE })
    }
    setBusy(false)
    onBusyChange(false)
    // Nothing comes back when the session ended and the page is going to sign-in.
    if (!result) return onFinish(null)
    if (result.ok || !isPinError(result.code)) return onFinish(result)
    switch (result.code) {
      case "TRANSACTION_PIN_INVALID":
        return setMode({ name: "enter", error: wrongPinMessage(result.attemptsLeft) })
      case "TRANSACTION_PIN_LOCKED":
        return setMode({ name: "locked", until: result.lockedUntil ?? result.retryAt ?? null })
      case "TRANSACTION_PIN_REQUIRED":
        return setMode(hasPassword === false ? { name: "no-password" } : { name: "setup" })
      default:
        return setMode({ name: "enter", error: "Enter your 4-digit PIN." })
    }
  }

  function submit(value = pin) {
    if (busy) return
    if (value.length !== PIN_LENGTH) return setMode({ name: "enter", error: "Enter all 4 digits of your PIN." })
    setPin("")
    void attempt(value)
  }

  const cancel = () => onFinish(null)

  if (mode.name === "reset") {
    return (
      <>
        <Header title="Reset your transaction PIN">
          Use a code we email you and your password, then choose a new PIN. We&apos;ll then {request.purpose}.
        </Header>
        <ResetPinForm
          idPrefix="pin-confirm-reset"
          submitLabel="Reset PIN and continue"
          cancelLabel="Back"
          onCancel={() => setMode(mode.back)}
          onReset={attempt}
        />
      </>
    )
  }

  if (mode.name === "setup") {
    return (
      <>
        <Header title="Set your transaction PIN">
          Choose 4 digits to confirm transfers, approvals and team changes from now on. Once it&apos;s set, we&apos;ll{" "}
          {request.purpose}.
        </Header>
        <SetPinForm
          idPrefix="pin-confirm-setup"
          submitLabel="Set PIN and continue"
          onCancel={cancel}
          onSet={attempt}
          onAlreadySet={() => setMode({ name: "enter", notice: "You already have a transaction PIN. Enter it to carry on." })}
        />
      </>
    )
  }

  if (mode.name === "no-password") {
    return (
      <>
        <Header title="Set a password first">You need a password to set a transaction PIN.</Header>
        <NoPasswordNotice onCancel={cancel} />
      </>
    )
  }

  if (mode.name === "locked") {
    return (
      <>
        <Header title="Your PIN is locked">
          It was entered wrongly too many times. Wait for it to unlock, or reset it now with your password and a code we
          email you.
        </Header>
        <p className="flex items-start gap-2.5 rounded-xl bg-warning-subtle p-4 text-sm text-warning-foreground">
          <Lock className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>{mode.until ? `It unlocks ${unlocksAt(mode.until)}.` : "It unlocks 30 minutes after the last wrong try."}</span>
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={cancel}>
            Close
          </Button>
          <Button onClick={() => setMode({ name: "reset", back: mode })}>Reset PIN</Button>
        </DialogFooter>
      </>
    )
  }

  return (
    <>
      <Header title="Confirm with your PIN">Enter your transaction PIN to {request.purpose}.</Header>
      {mode.name === "loading" ? (
        <div role="status" className="flex min-h-24 items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> One moment
        </div>
      ) : (
        <form
          noValidate
          className="grid gap-6"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          {mode.notice && <p className="rounded-lg bg-muted px-3 py-2.5 text-sm text-muted-foreground">{mode.notice}</p>}
          <Field data-invalid={!!mode.error}>
            <FieldLabel htmlFor="transaction-pin">Transaction PIN</FieldLabel>
            <PinInput
              id="transaction-pin"
              ref={input}
              value={pin}
              onChange={setPin}
              onComplete={submit}
              disabled={busy}
              invalid={!!mode.error}
              autoFocus
            />
            {mode.error && <FieldError>{mode.error}</FieldError>}
            <Button
              type="button"
              variant="link"
              className="h-auto w-fit p-0"
              disabled={busy}
              onClick={() => setMode({ name: "reset", back: { name: "enter" } })}
            >
              Forgot your PIN?
            </Button>
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={cancel} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || pin.length !== PIN_LENGTH}>
              {busy && <Spinner />}
              {request.confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      )}
    </>
  )
}

function Header({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <DialogHeader>
      <DialogTitle>{title}</DialogTitle>
      <DialogDescription>{children}</DialogDescription>
    </DialogHeader>
  )
}
