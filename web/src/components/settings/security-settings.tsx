"use client"

import { useEffect, useState, useTransition } from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { Check, Copy, Mail, ShieldCheck, ShieldOff, Smartphone } from "lucide-react"
import QRCode from "qrcode"
import { Controller, useForm } from "react-hook-form"
import { toast } from "sonner"
import type { z } from "zod"
import {
  disableTwoFactor,
  enableEmailTwoFactor,
  enableTotp,
  startTotpSetup,
} from "@/app/(dashboard)/settings/actions"
import { CodeInput } from "@/components/auth/code-input"
import { PasswordInput } from "@/components/auth/password-input"
import { FormError } from "@/components/common/form-error"
import { RecoveryCodesSection, RecoveryCodesView } from "@/components/settings/recovery-codes"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldError, FieldLabel } from "@/components/ui/field"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import type { ActionResult } from "@/lib/action-result"
import type { TwoFactorMethod } from "@/lib/api/types"
import { applyResult } from "@/lib/forms"
import { passwordConfirmSchema } from "@/lib/schemas"

type Props = {
  enabled: boolean
  method: TwoFactorMethod | null
  email: string
  /** Unused recovery codes; only meaningful with the authenticator app. */
  recoveryCodesLeft: number
  hasPassword: boolean
}
type Open = "totp" | "email" | "disable" | null

export function SecuritySettings({ enabled, method, email, recoveryCodesLeft, hasPassword }: Props) {
  const [open, setOpen] = useState<Open>(null)
  const close = () => setOpen(null)
  // Leaving the authenticator app deletes its recovery codes.
  const codesGo = enabled && method === "totp" ? " Your recovery codes will stop working." : ""

  return (
    <div className="grid gap-10">
      <section className="grid gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="grid gap-1">
            <h2 className="text-sm font-medium">Two-step verification</h2>
            <p className="text-sm text-muted-foreground">
              After your password, we ask for a code. Choose where that code comes from.
            </p>
          </div>
          {enabled ? (
            <Badge variant="success">
              <ShieldCheck data-icon="inline-start" aria-hidden />
              On
            </Badge>
          ) : (
            <Badge variant="warning">
              <ShieldOff data-icon="inline-start" aria-hidden />
              Off
            </Badge>
          )}
        </div>

        <ul className="divide-y surface">
          <MethodRow
            icon={Smartphone}
            title="Authenticator app"
            description="Google Authenticator, Microsoft Authenticator, 1Password or any app that shows 6-digit codes. Works without network."
            active={enabled && method === "totp"}
            recommended
            action={
              <Button variant={enabled && method === "totp" ? "ghost" : "outline"} size="sm" onClick={() => setOpen("totp")}>
                {enabled && method === "totp" ? "Move to a new phone" : method === "email" ? "Switch to app" : "Set up"}
              </Button>
            }
          />
          <MethodRow
            icon={Mail}
            title="Email codes"
            description={`We email a code to ${email} each time you sign in with your password.`}
            active={enabled && method === "email"}
            action={
              !(enabled && method === "email") && (
                <Button variant="outline" size="sm" onClick={() => setOpen("email")}>
                  {method === "totp" ? "Switch to email" : "Turn on"}
                </Button>
              )
            }
          />
        </ul>
      </section>

      {enabled && method === "totp" && <RecoveryCodesSection left={recoveryCodesLeft} hasPassword={hasPassword} email={email} />}

      {enabled && (
        <section className="grid gap-3 border-t pt-8">
          <h2 className="text-sm font-medium">Turn off two-step verification</h2>
          <p className="max-w-[65ch] text-sm text-muted-foreground">
            Anyone with your password could then sign in to your business account. We don&apos;t recommend this.
          </p>
          <Button variant="destructive" size="sm" className="w-fit" onClick={() => setOpen("disable")}>
            Turn off
          </Button>
        </section>
      )}

      <TotpDialog open={open === "totp"} onClose={close} email={email} />
      <PasswordDialog
        open={open === "email"}
        onClose={close}
        title="Use email codes"
        description={`Confirm your password. From your next sign-in, we'll email a code to ${email}.${codesGo}`}
        confirmLabel="Turn on email codes"
        onConfirm={enableEmailTwoFactor}
        successMessage="Email codes are on."
      />
      <PasswordDialog
        open={open === "disable"}
        onClose={close}
        title="Turn off two-step verification?"
        description={`Confirm your password. You'll sign in with your password alone.${codesGo}`}
        confirmLabel="Turn off"
        destructive
        onConfirm={disableTwoFactor}
        successMessage="Two-step verification is off."
      />
    </div>
  )
}

function MethodRow({
  icon: Icon,
  title,
  description,
  active,
  recommended,
  action,
}: {
  icon: typeof Mail
  title: string
  description: string
  active: boolean
  recommended?: boolean
  action: React.ReactNode
}) {
  return (
    <li className="flex flex-wrap items-start gap-4 p-4 sm:flex-nowrap">
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
        <Icon className="size-4" aria-hidden />
      </span>
      <div className="grid min-w-0 flex-1 gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{title}</span>
          {active && <Badge variant="success">In use</Badge>}
          {recommended && !active && <Badge variant="outline">Recommended</Badge>}
        </div>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="shrink-0">{action}</div>
    </li>
  )
}

// ---- Authenticator setup ----

type TotpSecret = { secret: string; otpauthUrl: string }

function TotpDialog({ open, onClose, email }: { open: boolean; onClose: () => void; email: string }) {
  // The recovery codes from turning it on. Only "I've saved them" closes the dialog while they show.
  const [codes, setCodes] = useState<string[] | null>(null)
  const keepOpen = (e: Event) => {
    if (codes) e.preventDefault()
  }
  return (
    <Dialog open={open} onOpenChange={(o) => !o && !codes && onClose()}>
      <DialogContent className="sm:max-w-md" showCloseButton={!codes} onInteractOutside={keepOpen} onEscapeKeyDown={keepOpen}>
        {codes ? (
          <>
            <DialogHeader>
              <DialogTitle>Save your recovery codes</DialogTitle>
              <DialogDescription>Your authenticator app is set up.</DialogDescription>
            </DialogHeader>
            <RecoveryCodesView
              codes={codes}
              email={email}
              onDone={() => {
                setCodes(null)
                onClose()
              }}
            />
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Set up an authenticator app</DialogTitle>
              <DialogDescription>
                Confirm your password, scan the code with your app, then enter the 6-digit code it shows.
              </DialogDescription>
            </DialogHeader>
            {/* Mounted only while open, so every setup starts with a fresh secret and empty state. */}
            {open && <TotpFlow onClose={onClose} onEnabled={setCodes} />}
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function TotpFlow({ onClose, onEnabled }: { onClose: () => void; onEnabled: (codes: string[]) => void }) {
  const [started, setStarted] = useState<TotpSecret | null>(null)
  return started ? (
    <TotpSetup started={started} onClose={onClose} onEnabled={onEnabled} />
  ) : (
    <TotpPassword onStarted={setStarted} onClose={onClose} />
  )
}

/** The password comes first, so a stolen session alone can't add or swap the authenticator. */
function TotpPassword({ onStarted, onClose }: { onStarted: (started: TotpSecret) => void; onClose: () => void }) {
  const form = useForm<PasswordValues>({ resolver: zodResolver(passwordConfirmSchema), defaultValues: { password: "" } })
  const { isSubmitting, errors } = form.formState

  async function onSubmit(values: PasswordValues) {
    const result = await startTotpSetup(values)
    if (!result.ok && result.error === "That password is incorrect.") {
      form.setError("password", { message: result.error })
      return
    }
    if (applyResult(form, result)) onStarted(result.data)
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid gap-6">
      <FormError message={errors.root?.message} />
      <Controller
        name="password"
        control={form.control}
        render={({ field, fieldState }) => (
          <Field data-invalid={fieldState.invalid}>
            <FieldLabel htmlFor="totp-password">Password</FieldLabel>
            <PasswordInput
              id="totp-password"
              autoComplete="current-password"
              autoFocus
              aria-invalid={fieldState.invalid}
              {...field}
            />
            <FieldError errors={[fieldState.error]} />
          </Field>
        )}
      />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting && <Spinner />}
          Continue
        </Button>
      </DialogFooter>
    </form>
  )
}

function TotpSetup({
  started,
  onClose,
  onEnabled,
}: {
  started: TotpSecret
  onClose: () => void
  onEnabled: (codes: string[]) => void
}) {
  const [qr, setQr] = useState<string>()
  const [code, setCode] = useState("")
  const [error, setError] = useState<string>()
  const [copied, setCopied] = useState(false)
  const [pending, startTransition] = useTransition()

  useEffect(() => {
    let cancelled = false
    QRCode.toDataURL(started.otpauthUrl, { margin: 1, width: 320, errorCorrectionLevel: "M" }).then((url) => {
      if (!cancelled) setQr(url)
    })
    return () => {
      cancelled = true
    }
  }, [started])

  function confirm(value = code) {
    if (value.length !== 6) return setError("Enter the 6-digit code from the app.")
    setError(undefined)
    startTransition(async () => {
      const result = await enableTotp({ code: value })
      if (result.ok) {
        if (result.data.recoveryCodes?.length) return onEnabled(result.data.recoveryCodes)
        toast.success("Authenticator app is set up.")
        onClose()
      } else {
        setCode("")
        setError(result.code === "INVALID_CODE" ? "That code didn't match. Wait for a new code in the app and try again." : result.error)
      }
    })
  }

  async function copySecret() {
    await navigator.clipboard.writeText(started.secret)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <form
      className="grid gap-6"
      onSubmit={(e) => {
        e.preventDefault()
        confirm()
      }}
    >
      <div className="grid gap-4 sm:grid-cols-[10rem_minmax(0,1fr)] sm:items-center">
        {qr ? (
          // eslint-disable-next-line @next/next/no-img-element -- data URL generated on the client
          <img
            src={qr}
            alt="QR code for your authenticator app"
            width={160}
            height={160}
            className="size-40 rounded-lg border bg-white p-2"
          />
        ) : (
          <Skeleton className="size-40 rounded-lg" />
        )}
        <div className="grid gap-2 text-sm">
          <p className="text-muted-foreground">Can&apos;t scan? Enter this key in the app instead:</p>
          <div className="flex items-center gap-1 rounded-lg border bg-muted/50 py-1 pr-1 pl-3">
            <code className="min-w-0 flex-1 font-mono text-xs break-all">{started.secret.match(/.{1,4}/g)?.join(" ")}</code>
            <Button type="button" variant="ghost" size="icon-sm" onClick={copySecret} aria-label="Copy key">
              {copied ? <Check className="text-primary" /> : <Copy />}
            </Button>
          </div>
        </div>
      </div>

      <Field data-invalid={!!error}>
        <FieldLabel htmlFor="totp-code">Code from the app</FieldLabel>
        <CodeInput
          id="totp-code"
          value={code}
          onChange={setCode}
          onComplete={confirm}
          disabled={pending}
          invalid={!!error}
          autoFocus={false}
        />
        {error && <FieldError>{error}</FieldError>}
      </Field>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending || code.length !== 6}>
          {pending && <Spinner />}
          Turn on
        </Button>
      </DialogFooter>
    </form>
  )
}

// ---- Password confirmation ----

type PasswordValues = z.infer<typeof passwordConfirmSchema>

function PasswordDialog({
  open,
  onClose,
  title,
  description,
  confirmLabel,
  destructive,
  onConfirm,
  successMessage,
}: {
  open: boolean
  onClose: () => void
  title: string
  description: string
  confirmLabel: string
  destructive?: boolean
  onConfirm: (values: PasswordValues) => Promise<ActionResult<unknown>>
  successMessage: string
}) {
  const form = useForm<PasswordValues>({ resolver: zodResolver(passwordConfirmSchema), defaultValues: { password: "" } })
  const { isSubmitting, errors } = form.formState

  useEffect(() => {
    if (open) form.reset({ password: "" })
  }, [open, form])

  async function onSubmit(values: PasswordValues) {
    const result = await onConfirm(values)
    if (!result.ok && result.error === "That password is incorrect.") {
      form.setError("password", { message: result.error })
      return
    }
    if (applyResult(form, result)) {
      toast.success(successMessage)
      onClose()
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid gap-6">
          <FormError message={errors.root?.message} />
          <Controller
            name="password"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="confirm-password">Password</FieldLabel>
                <PasswordInput
                  id="confirm-password"
                  autoComplete="current-password"
                  autoFocus
                  aria-invalid={fieldState.invalid}
                  {...field}
                />
                <FieldError errors={[fieldState.error]} />
              </Field>
            )}
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant={destructive ? "destructive" : "default"} disabled={isSubmitting}>
              {isSubmitting && <Spinner />}
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
