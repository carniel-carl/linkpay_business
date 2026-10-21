"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { CodeInput } from "@/components/auth/code-input"
import { ResendButton } from "@/components/auth/resend-button"
import { FormError } from "@/components/common/form-error"
import { Button } from "@/components/ui/button"
import { Field, FieldLabel } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import type { TwoFactorMethod } from "@/lib/api/types"
import { resendTwoFactor, verifyTwoFactor } from "../../actions"

export function TwoFactorForm({ method, next }: { method: TwoFactorMethod; next?: string }) {
  const router = useRouter()
  const [code, setCode] = useState("")
  const [error, setError] = useState<string>()
  const [pending, startTransition] = useTransition()

  function submit(value = code) {
    if (value.length !== 6) return setError("Enter the 6-digit code.")
    setError(undefined)
    startTransition(async () => {
      const result = await verifyTwoFactor({ code: value }, next)
      if (result.ok) return
      // The 10-minute challenge ran out: the password step has to be repeated.
      if (result.code === "INVALID_STAFF_TOKEN") {
        router.replace("/sign-in")
        return
      }
      setError(result.error)
      setCode("")
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
        <FieldLabel htmlFor="code">{method === "totp" ? "Authenticator code" : "Email code"}</FieldLabel>
        <CodeInput id="code" value={code} onChange={setCode} onComplete={submit} disabled={pending} invalid={!!error} />
      </Field>
      <Button type="submit" size="lg" className="w-full sm:w-fit" disabled={pending || code.length !== 6}>
        {pending && <Spinner />}
        Verify and sign in
      </Button>
      {method === "email" && <ResendButton onResend={resendTwoFactor} />}
    </form>
  )
}
