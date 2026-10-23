"use client"

import { useEffect, useState, useTransition } from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { Controller, useForm } from "react-hook-form"
import { toast } from "sonner"
import { changePassword, startSettingPassword } from "@/app/(dashboard)/settings/security/actions"
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
import { Spinner } from "@/components/ui/spinner"
import { applyResult } from "@/lib/forms"
import { changePasswordSchema, type ChangePasswordValues } from "@/lib/schemas"

/**
 * Change the password (needs the current one; other devices are signed out). An account whose password was
 * removed when its email was verified sets one through a reset instead.
 */
export function PasswordSettings({ hasPassword, email }: { hasPassword: boolean; email: string }) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string>()
  const [pending, startTransition] = useTransition()

  function setPassword() {
    setError(undefined)
    startTransition(async () => {
      const result = await startSettingPassword()
      if (!result.ok) setError(result.error)
    })
  }

  return (
    <section className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="grid gap-1">
          <h2 className="text-sm font-medium">Password</h2>
          <p className="text-sm text-muted-foreground">
            {hasPassword
              ? "Changing it signs you out on every other device."
              : `You sign in with codes we email to ${email}. Set a password to sign in with it too.`}
          </p>
        </div>
        {hasPassword ? (
          <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
            Change password
          </Button>
        ) : (
          <Badge variant="warning">Not set</Badge>
        )}
      </div>

      {!hasPassword && (
        <div className="grid gap-3">
          <FormError message={error} />
          <p className="max-w-[65ch] text-sm text-muted-foreground">
            We&apos;ll email you a code to choose one. Setting it signs you out on every device, this one too.
          </p>
          <Button size="sm" className="w-fit" disabled={pending} onClick={setPassword}>
            {pending && <Spinner />}
            Set a password
          </Button>
        </div>
      )}

      <ChangePasswordDialog open={open} onClose={() => setOpen(false)} />
    </section>
  )
}

function ChangePasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const form = useForm<ChangePasswordValues>({
    resolver: zodResolver(changePasswordSchema),
    defaultValues: { currentPassword: "", newPassword: "" },
  })
  const { isSubmitting, errors } = form.formState

  useEffect(() => {
    if (open) form.reset({ currentPassword: "", newPassword: "" })
  }, [open, form])

  async function onSubmit(values: ChangePasswordValues) {
    const result = await changePassword(values)
    if (!result.ok && result.code === "INCORRECT_PASSWORD") {
      form.setError("currentPassword", { message: result.error }, { shouldFocus: true })
      return
    }
    if (applyResult(form, result)) {
      toast.success("Password changed. Your other devices are signed out.")
      onClose()
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Change your password</DialogTitle>
          <DialogDescription>You stay signed in here. Every other device signs in again with the new password.</DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid gap-6">
          <FormError message={errors.root?.message} />
          <FieldGroup>
            <Controller
              name="currentPassword"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="current-password">Current password</FieldLabel>
                  <PasswordInput
                    id="current-password"
                    autoComplete="current-password"
                    autoFocus
                    aria-invalid={fieldState.invalid}
                    {...field}
                  />
                  <FieldError errors={[fieldState.error]} />
                </Field>
              )}
            />
            <Controller
              name="newPassword"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="new-password">New password</FieldLabel>
                  <PasswordInput id="new-password" autoComplete="new-password" aria-invalid={fieldState.invalid} {...field} />
                  {fieldState.error ? (
                    <FieldError errors={[fieldState.error]} />
                  ) : (
                    <FieldDescription>At least 8 characters.</FieldDescription>
                  )}
                </Field>
              )}
            />
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting && <Spinner />}
              Change password
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
