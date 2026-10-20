"use client"

import { useState, useTransition } from "react"
import { CodeInput } from "@/components/auth/code-input"
import { ResendButton } from "@/components/auth/resend-button"
import { FormError } from "@/components/common/form-error"
import { Button } from "@/components/ui/button"
import { Field, FieldLabel } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import { resendVerification, verifyEmail } from "../actions"

export function VerifyEmailForm({ email }: { email: string }) {
  const [code, setCode] = useState("")
  const [error, setError] = useState<string>()
  const [pending, startTransition] = useTransition()

  function submit(value = code) {
    if (value.length !== 6) return setError("Enter the 6-digit code.")
    setError(undefined)
    startTransition(async () => {
      const result = await verifyEmail({ email, code: value })
      if (!result.ok) {
        setError(result.error)
        setCode("")
      }
    })
  }

  return (
    <form
      className="grid gap-6"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <FormError message={error} />
      <Field>
        <FieldLabel htmlFor="code">Verification code</FieldLabel>
        <CodeInput id="code" value={code} onChange={setCode} onComplete={submit} disabled={pending} invalid={!!error} />
      </Field>
      <Button type="submit" size="lg" disabled={pending || code.length !== 6}>
        {pending && <Spinner />}
        Verify email
      </Button>
      <ResendButton onResend={() => resendVerification({ email })} />
    </form>
  )
}
