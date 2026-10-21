"use client"

import { useEffect, useState, useTransition } from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { Check, Copy, Mail, ShieldCheck, Smartphone } from "lucide-react"
import QRCode from "qrcode"
import { Controller, useForm } from "react-hook-form"
import { toast } from "sonner"
import type { z } from "zod"
import { changePassword, enableEmailTwoFactor, enableTotp, startTotpSetup } from "@/app/(console)/security/actions"
import { CodeInput } from "@/components/auth/code-input"
import { PasswordInput } from "@/components/auth/password-input"
import { FormError } from "@/components/common/form-error"
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
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import type { ActionResult } from "@/lib/action-result"
import type { TwoFactorMethod } from "@/lib/api/types"
import { applyResult } from "@/lib/forms"
import { changePasswordSchema, passwordConfirmSchema } from "@/lib/schemas"

// Two-step is always on for staff (the backend has no "off"), so this only switches the method.
type Props = { method: TwoFactorMethod; email: string }
type Open = "totp" | "email" | null

export function SecuritySettings({ method, email }: Props) {
  const [open, setOpen] = useState<Open>(null)
  const close = () => setOpen(null)

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
          <Badge variant="success">
            <ShieldCheck data-icon="inline-start" aria-hidden />
            Always on
          </Badge>
        </div>

        <ul className="divide-y surface">
          <MethodRow
            icon={Smartphone}
            title="Authenticator app"
            description="Google Authenticator, Microsoft Authenticator, 1Password or any app that shows 6-digit codes. Works without network."
            active={method === "totp"}
            recommended
            action={
              <Button variant={method === "totp" ? "ghost" : "outline"} size="sm" onClick={() => setOpen("totp")}>
                {method === "totp" ? "Move to a new phone" : "Switch to app"}
              </Button>
            }
          />
          <MethodRow
            icon={Mail}
            title="Email codes"
            description={`We email a code to ${email} each time you sign in with your password.`}
            active={method === "email"}
            action={
              method !== "email" && (
                <Button variant="outline" size="sm" onClick={() => setOpen("email")}>
                  Switch to email
                </Button>
              )
            }
          />
        </ul>
      </section>

      <TotpDialog open={open === "totp"} onClose={close} />
      <PasswordDialog
        open={open === "email"}
        onClose={close}
        title="Use email codes"
        description={`Confirm your password. From your next sign-in, we'll email a code to ${email}.`}
        confirmLabel="Use email codes"
        onConfirm={enableEmailTwoFactor}
        successMessage="Email codes are on."
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

function TotpDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Set up an authenticator app</DialogTitle>
          <DialogDescription>Scan the code with your app, then enter the 6-digit code it shows.</DialogDescription>
        </DialogHeader>
        {/* Mounted only while open, so every setup starts with a fresh secret and empty state. */}
        {open && <TotpSetup onClose={onClose} />}
      </DialogContent>
    </Dialog>
  )
}

function TotpSetup({ onClose }: { onClose: () => void }) {
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null)
  const [loadError, setLoadError] = useState<string>()
  const [code, setCode] = useState("")
  const [error, setError] = useState<string>()
  const [copied, setCopied] = useState(false)
  const [pending, startTransition] = useTransition()

  useEffect(() => {
    let cancelled = false
    startTotpSetup().then(async (result) => {
      if (cancelled) return
      if (!result.ok) return setLoadError(result.error)
      const qr = await QRCode.toDataURL(result.data.otpauthUrl, { margin: 1, width: 320, errorCorrectionLevel: "M" })
      if (!cancelled) setSetup({ secret: result.data.secret, qr })
    })
    return () => {
      cancelled = true
    }
  }, [])

  function confirm(value = code) {
    if (value.length !== 6) return setError("Enter the 6-digit code from the app.")
    setError(undefined)
    startTransition(async () => {
      const result = await enableTotp({ code: value })
      if (result.ok) {
        toast.success("Authenticator app is set up.")
        onClose()
      } else {
        setCode("")
        setError(result.code === "INVALID_CODE" ? "That code didn't match. Wait for a new code in the app and try again." : result.error)
      }
    })
  }

  async function copySecret() {
    if (!setup) return
    await navigator.clipboard.writeText(setup.secret)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <>
        {loadError ? (
          <FormError message={loadError} />
        ) : (
          <form
            className="grid gap-6"
            onSubmit={(e) => {
              e.preventDefault()
              confirm()
            }}
          >
            <div className="grid gap-4 sm:grid-cols-[10rem_minmax(0,1fr)] sm:items-center">
              {setup ? (
                // eslint-disable-next-line @next/next/no-img-element -- data URL generated on the client
                <img
                  src={setup.qr}
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
                {setup ? (
                  <div className="flex items-center gap-1 rounded-lg border bg-muted/50 py-1 pr-1 pl-3">
                    <code className="min-w-0 flex-1 font-mono text-xs break-all">
                      {setup.secret.match(/.{1,4}/g)?.join(" ")}
                    </code>
                    <Button type="button" variant="ghost" size="icon-sm" onClick={copySecret} aria-label="Copy key">
                      {copied ? <Check className="text-primary" /> : <Copy />}
                    </Button>
                  </div>
                ) : (
                  <Skeleton className="h-9 w-full" />
                )}
              </div>
            </div>

            <Field data-invalid={!!error}>
              <FieldLabel htmlFor="totp-code">Code from the app</FieldLabel>
              <CodeInput
                id="totp-code"
                value={code}
                onChange={setCode}
                onComplete={confirm}
                disabled={!setup || pending}
                invalid={!!error}
                autoFocus={false}
              />
              {error && <FieldError>{error}</FieldError>}
            </Field>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={!setup || pending || code.length !== 6}>
                {pending && <Spinner />}
                Turn on
              </Button>
            </DialogFooter>
          </form>
        )}
    </>
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
  onConfirm,
  successMessage,
}: {
  open: boolean
  onClose: () => void
  title: string
  description: string
  confirmLabel: string
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
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting && <Spinner />}
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ---- Password ----

type ChangePasswordValues = z.infer<typeof changePasswordSchema>

export function ChangePasswordForm() {
  const form = useForm<ChangePasswordValues>({
    resolver: zodResolver(changePasswordSchema),
    defaultValues: { currentPassword: "", newPassword: "", confirmPassword: "" },
  })
  const { isSubmitting, errors } = form.formState

  async function onSubmit(values: ChangePasswordValues) {
    const result = await changePassword(values)
    if (!result.ok && result.code === "INCORRECT_PASSWORD") {
      form.setError("currentPassword", { message: result.error })
      return
    }
    if (applyResult(form, result)) {
      toast.success("Password changed. Your other sessions are signed out.")
      form.reset()
    }
  }

  const fields = [
    { name: "currentPassword", label: "Current password", autoComplete: "current-password" },
    { name: "newPassword", label: "New password", autoComplete: "new-password", hint: "At least 8 characters." },
    { name: "confirmPassword", label: "Confirm new password", autoComplete: "new-password" },
  ] as const

  return (
    <section className="grid gap-4 border-t pt-8">
      <div className="grid gap-1">
        <h2 className="text-sm font-medium">Password</h2>
        <p className="text-sm text-muted-foreground">Changing it signs you out everywhere else.</p>
      </div>
      <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid max-w-sm gap-6">
        <FormError message={errors.root?.message} />
        <FieldGroup>
          {fields.map((f) => (
            <Controller
              key={f.name}
              name={f.name}
              control={form.control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor={f.name}>{f.label}</FieldLabel>
                  <PasswordInput id={f.name} autoComplete={f.autoComplete} aria-invalid={fieldState.invalid} {...field} />
                  {"hint" in f && !fieldState.invalid && <FieldDescription>{f.hint}</FieldDescription>}
                  <FieldError errors={[fieldState.error]} />
                </Field>
              )}
            />
          ))}
        </FieldGroup>
        <Button type="submit" className="w-fit" disabled={isSubmitting}>
          {isSubmitting && <Spinner />}
          Change password
        </Button>
      </form>
    </section>
  )
}
