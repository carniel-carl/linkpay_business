"use client"

import { zodResolver } from "@hookform/resolvers/zod"
import { ArrowRight } from "lucide-react"
import { Controller, useForm } from "react-hook-form"
import type { z } from "zod"
import { PasswordInput } from "@/components/auth/password-input"
import { FormError } from "@/components/common/form-error"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { applyResult } from "@/lib/forms"
import { acceptInviteSchema } from "@/lib/schemas"
import { acceptInvite } from "./actions"

type Values = z.infer<typeof acceptInviteSchema>

export function AcceptInviteForm({ token, email }: { token: string; email: string }) {
  const form = useForm<Values>({
    resolver: zodResolver(acceptInviteSchema),
    defaultValues: { name: "", password: "", confirmPassword: "" },
  })
  const { isSubmitting, errors } = form.formState

  async function onSubmit(values: Values) {
    applyResult(form, await acceptInvite(token, email, values))
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid gap-6">
      <FormError message={errors.root?.message} />
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="invite-email">Email</FieldLabel>
          <Input id="invite-email" type="email" value={email} readOnly disabled />
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
        <div className="grid gap-4 sm:grid-cols-2 sm:items-start">
          <Controller
            name="password"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="password">Password</FieldLabel>
                <PasswordInput id="password" autoComplete="new-password" aria-invalid={fieldState.invalid} {...field} />
                {fieldState.error ? (
                  <FieldError errors={[fieldState.error]} />
                ) : (
                  <FieldDescription>At least 8 characters.</FieldDescription>
                )}
              </Field>
            )}
          />
          <Controller
            name="confirmPassword"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="confirm-password">Confirm password</FieldLabel>
                <PasswordInput
                  id="confirm-password"
                  autoComplete="new-password"
                  aria-invalid={fieldState.invalid}
                  {...field}
                />
                <FieldError errors={[fieldState.error]} />
              </Field>
            )}
          />
        </div>
      </FieldGroup>
      <Button type="submit" size="lg" className="w-full sm:w-fit" disabled={isSubmitting}>
        {isSubmitting && <Spinner />}
        Create staff sign-in
        {!isSubmitting && <ArrowRight data-icon="inline-end" aria-hidden />}
      </Button>
    </form>
  )
}
