"use client"

import { useState, useTransition } from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { ArrowRight, LogOut } from "lucide-react"
import { Controller, useForm } from "react-hook-form"
import { PasswordInput } from "@/components/auth/password-input"
import { FormError } from "@/components/common/form-error"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { applyResult } from "@/lib/forms"
import { inviteRegisterSchema, type InviteRegisterValues } from "@/lib/schemas"
import { acceptInvite, registerFromInvite, switchAccount } from "./actions"

/** New to LinkPay: name and password; the email is the invited one and can't change. */
export function InviteRegisterForm({ token, email }: { token: string; email: string }) {
  const form = useForm<InviteRegisterValues>({
    resolver: zodResolver(inviteRegisterSchema),
    defaultValues: { name: "", password: "" },
  })
  const { isSubmitting, errors } = form.formState

  async function onSubmit(values: InviteRegisterValues) {
    // Redirects to the dashboard on success.
    applyResult(form, await registerFromInvite(token, values))
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid gap-6">
      <FormError message={errors.root?.message} />
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="invite-email">Email</FieldLabel>
          <Input id="invite-email" type="email" value={email} readOnly aria-readonly className="bg-muted/60 text-muted-foreground" />
          <FieldDescription>You&apos;ll sign in with this email. The invite was sent to it.</FieldDescription>
        </Field>
        <Controller
          name="name"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="name">Full name</FieldLabel>
              <Input id="name" autoComplete="name" aria-invalid={fieldState.invalid} {...field} />
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />
        <Controller
          name="password"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="password">Create a password</FieldLabel>
              <PasswordInput id="password" autoComplete="new-password" aria-invalid={fieldState.invalid} {...field} />
              {fieldState.error ? (
                <FieldError errors={[fieldState.error]} />
              ) : (
                <FieldDescription>At least 8 characters.</FieldDescription>
              )}
            </Field>
          )}
        />
      </FieldGroup>
      <Button type="submit" size="lg" disabled={isSubmitting}>
        {isSubmitting && <Spinner />}
        Create account and join
      </Button>
    </form>
  )
}

/** Signed in with the invited email. */
export function AcceptInviteButton({ token, businessName }: { token: string; businessName: string }) {
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string>()

  return (
    <div className="grid gap-4">
      <FormError message={error} />
      <Button
        size="lg"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            // Redirects to the dashboard on success.
            const result = await acceptInvite(token)
            if (!result.ok) setError(result.error)
          })
        }
      >
        {pending && <Spinner />}
        Join {businessName}
        {!pending && <ArrowRight data-icon="inline-end" aria-hidden />}
      </Button>
    </div>
  )
}

/** Signed in as someone other than the invited email. */
export function SwitchAccountButton({ token, accountExists }: { token: string; accountExists: boolean }) {
  const [pending, startTransition] = useTransition()
  return (
    <Button
      size="lg"
      variant="outline"
      disabled={pending}
      onClick={() => startTransition(() => switchAccount(token, accountExists))}
    >
      {pending ? <Spinner /> : <LogOut data-icon="inline-start" aria-hidden />}
      Sign out and switch account
    </Button>
  )
}
