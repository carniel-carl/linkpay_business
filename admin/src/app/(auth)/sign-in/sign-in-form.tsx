"use client"

import { zodResolver } from "@hookform/resolvers/zod"
import { ArrowRight } from "lucide-react"
import { Controller, useForm } from "react-hook-form"
import type { z } from "zod"
import { PasswordInput } from "@/components/auth/password-input"
import { FormError } from "@/components/common/form-error"
import { Button } from "@/components/ui/button"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { applyResult } from "@/lib/forms"
import { signInSchema } from "@/lib/schemas"
import { signIn } from "../actions"

type Values = z.infer<typeof signInSchema>

export function SignInForm({ next }: { next?: string }) {
  const form = useForm<Values>({
    resolver: zodResolver(signInSchema),
    defaultValues: { email: "", password: "" },
  })
  const { isSubmitting, errors } = form.formState

  async function onSubmit(values: Values) {
    applyResult(form, await signIn(values, next))
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid gap-6">
      <FormError message={errors.root?.message} />
      {/* Side by side from sm, like the boxes on a slip; one column on phones. */}
      <FieldGroup className="sm:grid sm:grid-cols-2 sm:items-start sm:gap-4">
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
        <Controller
          name="password"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="password">Password</FieldLabel>
              <PasswordInput
                id="password"
                autoComplete="current-password"
                aria-invalid={fieldState.invalid}
                {...field}
              />
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />
      </FieldGroup>
      <Button type="submit" size="lg" className="w-full sm:w-fit" disabled={isSubmitting}>
        {isSubmitting && <Spinner />}
        Continue
        {!isSubmitting && <ArrowRight data-icon="inline-end" aria-hidden />}
      </Button>
    </form>
  )
}
