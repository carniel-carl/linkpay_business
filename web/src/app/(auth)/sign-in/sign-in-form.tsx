"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { zodResolver } from "@hookform/resolvers/zod"
import { Info, Mail } from "lucide-react"
import { Controller, useForm } from "react-hook-form"
import type { z } from "zod"
import { PasswordInput } from "@/components/auth/password-input"
import { FormError } from "@/components/common/form-error"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Field, FieldError, FieldGroup, FieldLabel, FieldSeparator } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { applyResult } from "@/lib/forms"
import { signInSchema } from "@/lib/schemas"
import { signIn } from "../actions"

type Values = z.infer<typeof signInSchema>

/**
 * `email` prefills the field (an invite link knows which account to use). `sessionEnded` says so once, on
 * arrival: the note goes when they submit, so it never sits beside an error.
 */
export function SignInForm({ next, email, sessionEnded }: { next?: string; email?: string; sessionEnded?: boolean }) {
  const form = useForm<Values>({
    resolver: zodResolver(signInSchema),
    defaultValues: { email: email ?? "", password: "" },
  })
  const { isSubmitting, errors } = form.formState
  const [showSessionEnded, setShowSessionEnded] = useState(!!sessionEnded)

  // Take `expired` out of the address so a refresh or Back doesn't say it again.
  useEffect(() => {
    if (!sessionEnded) return
    const url = new URL(window.location.href)
    url.searchParams.delete("expired")
    window.history.replaceState(null, "", url.pathname + url.search + url.hash)
  }, [sessionEnded])

  async function onSubmit(values: Values) {
    applyResult(form, await signIn(values, next))
  }

  const codeHref = next ? `/sign-in/code?next=${encodeURIComponent(next)}` : "/sign-in/code"

  return (
    <div className="grid gap-6">
      <form
        onSubmit={(e) => {
          setShowSessionEnded(false)
          return form.handleSubmit(onSubmit)(e)
        }}
        noValidate
        className="grid gap-6"
      >
        {showSessionEnded ? (
          <Alert>
            <Info aria-hidden />
            <AlertDescription>Your session ended. Sign in again to continue.</AlertDescription>
          </Alert>
        ) : (
          <FormError message={errors.root?.message} />
        )}
        <FieldGroup>
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
                <div className="flex items-baseline justify-between gap-3">
                  <FieldLabel htmlFor="password">Password</FieldLabel>
                  <Link href="/forgot-password" className="text-sm font-medium text-primary underline-offset-4 hover:underline">
                    Forgot password?
                  </Link>
                </div>
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
        <Button type="submit" size="lg" disabled={isSubmitting}>
          {isSubmitting && <Spinner />}
          Sign in
        </Button>
      </form>
      <FieldSeparator className="*:data-[slot=field-separator-content]:bg-card">or</FieldSeparator>
      <Button variant="outline" size="lg" asChild>
        <Link href={codeHref}>
          <Mail aria-hidden />
          Email me a sign-in code
        </Link>
      </Button>
    </div>
  )
}
