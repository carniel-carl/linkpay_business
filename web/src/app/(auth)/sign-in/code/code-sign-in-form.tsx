"use client"

import { useState, useTransition } from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { Controller, useForm } from "react-hook-form"
import type { z } from "zod"
import { AuthHeader } from "@/components/auth/auth-header"
import { CodeInput } from "@/components/auth/code-input"
import { ResendButton } from "@/components/auth/resend-button"
import { FormError } from "@/components/common/form-error"
import { Button } from "@/components/ui/button"
import { Field, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { applyResult } from "@/lib/forms"
import { emailOnlySchema } from "@/lib/schemas"
import { requestLoginCode, verifyLoginCode } from "../../actions"

type Values = z.infer<typeof emailOnlySchema>

export function CodeSignInForm({ next }: { next?: string }) {
  const [sentTo, setSentTo] = useState<string>()
  const form = useForm<Values>({ resolver: zodResolver(emailOnlySchema), defaultValues: { email: "" } })

  async function onSubmit(values: Values) {
    const result = await requestLoginCode(values)
    // A cooldown means a code went out less than a minute ago, so it's still usable.
    if (result.ok || result.code === "OTP_COOLDOWN") setSentTo(values.email)
    else applyResult(form, result)
  }

  if (sentTo) return <EnterCode email={sentTo} next={next} onChangeEmail={() => setSentTo(undefined)} />

  const { isSubmitting, errors } = form.formState
  return (
    <>
      <AuthHeader
        title="Sign in with a code"
        description="Enter your email and we'll send you a 6-digit code. No password needed."
      />
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
    </>
  )
}

function EnterCode({ email, next, onChangeEmail }: { email: string; next?: string; onChangeEmail: () => void }) {
  const [code, setCode] = useState("")
  const [error, setError] = useState<string>()
  const [pending, startTransition] = useTransition()

  function submit(value = code) {
    if (value.length !== 6) return setError("Enter the 6-digit code.")
    setError(undefined)
    startTransition(async () => {
      const result = await verifyLoginCode({ email, code: value }, next)
      if (!result.ok) {
        setError(result.error)
        setCode("")
      }
    })
  }

  return (
    <>
      <AuthHeader
        title="Check your email"
        description={
          <>
            If <span className="font-medium text-foreground">{email}</span> has a LinkPay account, a sign-in code is on
            its way. It expires in 10 minutes.
          </>
        }
      />
      <form
        className="grid gap-6"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <FormError message={error} />
        <Field>
          <FieldLabel htmlFor="code">Sign-in code</FieldLabel>
          <CodeInput id="code" value={code} onChange={setCode} onComplete={submit} disabled={pending} invalid={!!error} />
        </Field>
        <Button type="submit" size="lg" disabled={pending || code.length !== 6}>
          {pending && <Spinner />}
          Sign in
        </Button>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <ResendButton onResend={() => requestLoginCode({ email })} />
          <Button type="button" variant="link" className="h-auto p-0" onClick={onChangeEmail}>
            Use a different email
          </Button>
        </div>
      </form>
    </>
  )
}
