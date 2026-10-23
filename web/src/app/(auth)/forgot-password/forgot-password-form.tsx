"use client"

import { zodResolver } from "@hookform/resolvers/zod"
import { Controller, useForm } from "react-hook-form"
import type { z } from "zod"
import { FormError } from "@/components/common/form-error"
import { Button } from "@/components/ui/button"
import { Field, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { applyResult } from "@/lib/forms"
import { emailOnlySchema } from "@/lib/schemas"
import { requestPasswordReset } from "./actions"

type Values = z.infer<typeof emailOnlySchema>

export function ForgotPasswordForm() {
  const form = useForm<Values>({ resolver: zodResolver(emailOnlySchema), defaultValues: { email: "" } })
  const { isSubmitting, errors } = form.formState

  async function onSubmit(values: Values) {
    applyResult(form, await requestPasswordReset(values))
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid gap-6">
      <FormError message={errors.root?.message} />
      <Controller
        name="email"
        control={form.control}
        render={({ field, fieldState }) => (
          <Field data-invalid={fieldState.invalid}>
            <FieldLabel htmlFor="email">Email</FieldLabel>
            <Input id="email" type="email" autoComplete="email" aria-invalid={fieldState.invalid} {...field} />
            <FieldError errors={[fieldState.error]} />
          </Field>
        )}
      />
      <Button type="submit" size="lg" disabled={isSubmitting}>
        {isSubmitting && <Spinner />}
        Send code
      </Button>
    </form>
  )
}
