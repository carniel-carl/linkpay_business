"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { CodeInput } from "@/components/auth/code-input"
import { ResendButton } from "@/components/auth/resend-button"
import { FormError } from "@/components/common/form-error"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import type { TwoFactorMethod } from "@/lib/api/types"
import { resendTwoFactor, verifyTwoFactor } from "../../actions"

export function TwoFactorForm({ method, next }: { method: TwoFactorMethod; next?: string }) {
  const router = useRouter()
  // Recovery codes only exist for the authenticator app.
  const [recovery, setRecovery] = useState(false)
  const [code, setCode] = useState("")
  const [recoveryCode, setRecoveryCode] = useState("")
  const [error, setError] = useState<string>()
  const [pending, startTransition] = useTransition()

  function submit(value = code) {
    if (recovery) {
      if (!recoveryCode.trim()) return setError("Enter one of your recovery codes.")
    } else if (value.length !== 6) {
      return setError("Enter the 6-digit code.")
    }
    setError(undefined)
    startTransition(async () => {
      const result = await verifyTwoFactor(recovery ? { recoveryCode } : { code: value }, next)
      if (result.ok) return
      // The 10-minute challenge ran out: the password step has to be repeated.
      if (result.code === "INVALID_TOKEN") {
        router.replace("/sign-in")
        return
      }
      setError(result.error)
      if (!recovery) setCode("")
    })
  }

  function switchMode() {
    setRecovery((r) => !r)
    setError(undefined)
    setCode("")
    setRecoveryCode("")
  }

  return (
    <form
      className="grid gap-6"
      noValidate
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <FormError message={error} />
      {recovery ? (
        <Field data-invalid={!!error}>
          <FieldLabel htmlFor="recovery-code">Recovery code</FieldLabel>
          <Input
            id="recovery-code"
            value={recoveryCode}
            onChange={(e) => setRecoveryCode(e.target.value)}
            placeholder="abcde-fghjk"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            autoFocus
            disabled={pending}
            aria-invalid={!!error || undefined}
            className="h-11 font-mono tracking-wide"
          />
          <FieldDescription>
            One of the codes you saved when you set up your authenticator app. Each code works once.
          </FieldDescription>
        </Field>
      ) : (
        <Field>
          <FieldLabel htmlFor="code">{method === "totp" ? "Authenticator code" : "Email code"}</FieldLabel>
          <CodeInput id="code" value={code} onChange={setCode} onComplete={submit} disabled={pending} invalid={!!error} />
        </Field>
      )}
      <Button type="submit" size="lg" disabled={pending || (recovery ? !recoveryCode.trim() : code.length !== 6)}>
        {pending && <Spinner />}
        Verify and sign in
      </Button>
      {method === "email" && <ResendButton onResend={resendTwoFactor} />}
      {method === "totp" && (
        <p className="text-sm text-muted-foreground">
          {recovery ? "Have your phone? " : "Can't use your authenticator app? "}
          <Button type="button" variant="link" className="h-auto p-0" disabled={pending} onClick={switchMode}>
            {recovery ? "Use your authenticator app instead" : "Use a recovery code instead"}
          </Button>
        </p>
      )}
    </form>
  )
}
