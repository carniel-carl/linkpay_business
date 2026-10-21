"use client"

import { useState, useTransition } from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { Controller, useForm } from "react-hook-form"
import type { z } from "zod"
import Link from "next/link"
import { AuthFrame } from "@/components/auth/auth-frame"
import { CodeInput } from "@/components/auth/code-input"
import { signInLedger } from "@/components/auth/ledgers"
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
    <AuthFrame
      title="Sign in with a code"
      description="Enter your email and we'll send you a 6-digit code. No password needed."
      sheetTitle="Email me a code"
      ledger={signInLedger("code")}
    >
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
      <PasswordLink next={next} />
    </AuthFrame>
  )
}

function PasswordLink({ next }: { next?: string }) {
  return (
    <p className="mt-6 text-sm text-muted-foreground">
      <Link
        href={next ? `/sign-in?next=${encodeURIComponent(next)}` : "/sign-in"}
        className="font-medium text-primary underline-offset-4 hover:underline"
      >
        Sign in with your password instead
      </Link>
    </p>
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
    <AuthFrame
      title="Check your email"
      description={
        <>
          If <strong>{email}</strong> has a LinkPay account, a sign-in code is on its way. It expires in 10 minutes.
        </>
      }
      sheetTitle="Enter the code"
      ledger={signInLedger("code")}
    >
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
      <PasswordLink next={next} />
    </AuthFrame>
  )
}
