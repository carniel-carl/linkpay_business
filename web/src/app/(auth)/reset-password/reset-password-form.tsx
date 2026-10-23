"use client"

import { useState } from "react"
import Link from "next/link"
import { zodResolver } from "@hookform/resolvers/zod"
import { ArrowRight } from "lucide-react"
import { Controller, useForm } from "react-hook-form"
import { AuthFrame } from "@/components/auth/auth-frame"
import { CodeInput } from "@/components/auth/code-input"
import { resetLedger } from "@/components/auth/ledgers"
import { PasswordInput } from "@/components/auth/password-input"
import { ResendButton } from "@/components/auth/resend-button"
import { FormError } from "@/components/common/form-error"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import { applyResult } from "@/lib/forms"
import { resetPasswordSchema, type ResetPasswordValues } from "@/lib/schemas"
import { resendResetCode, resetPassword } from "./actions"

export function ResetPasswordForm({ email }: { email: string }) {
  const [done, setDone] = useState(false)
  const form = useForm<ResetPasswordValues>({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: { code: "", newPassword: "" },
  })
  const { isSubmitting, errors } = form.formState

  async function onSubmit(values: ResetPasswordValues) {
    const result = await resetPassword(email, values)
    if (!result.ok && result.code === "INVALID_CODE") {
      form.setValue("code", "")
      form.setError("code", { message: result.error }, { shouldFocus: true })
      return
    }
    if (applyResult(form, result)) setDone(true)
  }

  if (done) {
    return (
      <AuthFrame
        title="Password changed"
        description="We've signed you out on every device. Sign in with your new password."
        ledger={resetLedger("sign-in")}
        action={
          <Button variant="pop" size="lg" asChild>
            <Link href="/sign-in">
              Sign in
              <ArrowRight data-icon="inline-end" aria-hidden />
            </Link>
          </Button>
        }
      />
    )
  }

  return (
    <AuthFrame
      title="Choose a new password"
      description={
        <>
          If <strong>{email}</strong> has a LinkPay account, a 6-digit code is on its way. It expires in 10 minutes.
        </>
      }
      sheetTitle="Enter the code"
      ledger={resetLedger("password")}
    >
      <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid gap-6">
        <FormError message={errors.root?.message} />
        <FieldGroup>
          <Controller
            name="code"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="code">Reset code</FieldLabel>
                <CodeInput
                  id="code"
                  value={field.value}
                  onChange={field.onChange}
                  onComplete={() => form.setFocus("newPassword")}
                  disabled={isSubmitting}
                  invalid={fieldState.invalid}
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
        <Button type="submit" size="lg" disabled={isSubmitting}>
          {isSubmitting && <Spinner />}
          Set new password
        </Button>
        <ResendButton onResend={() => resendResetCode({ email })} />
      </form>
      <p className="mt-6 text-sm text-muted-foreground">
        Wrong email?{" "}
        <Link href="/forgot-password" className="font-medium text-primary underline-offset-4 hover:underline">
          Start again
        </Link>
      </p>
    </AuthFrame>
  )
}
