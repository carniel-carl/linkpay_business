"use client"

import { useState, useTransition } from "react"
import Link from "next/link"
import { zodResolver } from "@hookform/resolvers/zod"
import { KeyRound } from "lucide-react"
import { Controller, useForm, useWatch, type FieldValues, type Path, type PathValue, type UseFormReturn } from "react-hook-form"
import {
  changeTransactionPin,
  requestTransactionPinReset,
  resetTransactionPin,
  setTransactionPin,
} from "@/app/(dashboard)/transaction-pin-actions"
import { CodeInput } from "@/components/auth/code-input"
import { PasswordInput } from "@/components/auth/password-input"
import { ResendButton } from "@/components/auth/resend-button"
import { FormError } from "@/components/common/form-error"
import { Button } from "@/components/ui/button"
import { DialogFooter } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import type { ActionResult } from "@/lib/action-result"
import { applyResult } from "@/lib/forms"
import {
  changePinSchema,
  resetPinSchema,
  setPinSchema,
  type ChangePinValues,
  type ResetPinValues,
  type SetPinValues,
} from "@/lib/schemas"
import { wrongPinMessage } from "@/lib/transaction-pin"
import { cn } from "@/lib/utils"
import { PinInput } from "./pin-input"

// The forms for setting, changing and resetting the transaction PIN. Each renders inside a DialogContent (its
// buttons are a DialogFooter). A PIN is held only while it's typed: every form forgets its PINs as soon as
// it sends them, whatever the answer.

type PinFields = { newPin: string; confirmPin: string; currentPin?: string }

/** Empties every PIN field without validating, so nothing typed outlives the attempt. */
function forgetPins<T extends FieldValues>(form: UseFormReturn<T>, fields: (keyof PinFields)[]) {
  for (const f of fields) form.setValue(f as Path<T>, "" as PathValue<T, Path<T>>)
}

/** New PIN, then the same again. Weak PINs and a mismatch are caught before anything is sent. */
function NewPinFields<T extends PinFields>({ form, idPrefix }: { form: UseFormReturn<T>; idPrefix: string }) {
  const name = (n: keyof PinFields) => n as Path<T>
  return (
    <>
      <Controller
        name={name("newPin")}
        control={form.control}
        render={({ field, fieldState }) => (
          <Field data-invalid={fieldState.invalid}>
            <FieldLabel htmlFor={`${idPrefix}-new-pin`}>New PIN</FieldLabel>
            <PinInput
              id={`${idPrefix}-new-pin`}
              ref={field.ref}
              value={field.value as string}
              onChange={field.onChange}
              onComplete={() => form.setFocus(name("confirmPin"))}
              invalid={fieldState.invalid}
            />
            {fieldState.error ? (
              <FieldError errors={[fieldState.error]} />
            ) : (
              <FieldDescription>4 digits. Avoid repeated digits and runs like 1234.</FieldDescription>
            )}
          </Field>
        )}
      />
      <Controller
        name={name("confirmPin")}
        control={form.control}
        render={({ field, fieldState }) => (
          <Field data-invalid={fieldState.invalid}>
            <FieldLabel htmlFor={`${idPrefix}-confirm-pin`}>Enter the new PIN again</FieldLabel>
            <PinInput
              id={`${idPrefix}-confirm-pin`}
              ref={field.ref}
              value={field.value as string}
              onChange={field.onChange}
              invalid={fieldState.invalid}
            />
            <FieldError errors={[fieldState.error]} />
          </Field>
        )}
      />
    </>
  )
}

function PasswordField<T extends FieldValues>({
  form,
  id,
  autoFocus,
}: {
  form: UseFormReturn<T>
  id: string
  autoFocus?: boolean
}) {
  return (
    <Controller
      name={"password" as Path<T>}
      control={form.control}
      render={({ field, fieldState }) => (
        <Field data-invalid={fieldState.invalid}>
          <FieldLabel htmlFor={id}>Password</FieldLabel>
          <PasswordInput id={id} autoComplete="current-password" autoFocus={autoFocus} aria-invalid={fieldState.invalid} {...field} />
          <FieldError errors={[fieldState.error]} />
        </Field>
      )}
    />
  )
}

type FormProps = {
  /** Keeps ids unique when two of these forms could be on the page. */
  idPrefix: string
  submitLabel: string
  onCancel: () => void
  cancelLabel?: string
}

/** For an account with no password: setting or resetting a PIN needs one, so it sets a password first. */
export function NoPasswordNotice({ onCancel, cancelLabel = "Cancel" }: { onCancel: () => void; cancelLabel?: string }) {
  return (
    <div className="grid gap-6">
      <p className="flex items-start gap-2.5 rounded-xl bg-warning-subtle p-4 text-sm text-warning-foreground">
        <KeyRound className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span>
          Your account doesn&apos;t have a password yet, and you need one to set a transaction PIN. Set a password with a code we
          email you, then come back.
        </span>
      </p>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button asChild>
          <Link href="/forgot-password">Set a password</Link>
        </Button>
      </DialogFooter>
    </div>
  )
}

/** The first PIN: the account password, then the new PIN twice. */
export function SetPinForm({
  idPrefix,
  submitLabel,
  onCancel,
  cancelLabel = "Cancel",
  onSet,
  onAlreadySet,
}: FormProps & {
  /** After the PIN is saved, with the PIN, so a confirmation can carry straight on with it. */
  onSet: (pin: string) => void | Promise<void>
  /** A PIN was set somewhere else in the meantime (the app, another tab). */
  onAlreadySet?: () => void
}) {
  const [noPassword, setNoPassword] = useState(false)
  const form = useForm<SetPinValues>({
    resolver: zodResolver(setPinSchema),
    reValidateMode: "onBlur",
    defaultValues: { password: "", newPin: "", confirmPin: "" },
  })
  const { isSubmitting, errors } = form.formState

  async function onSubmit({ password, newPin }: SetPinValues) {
    forgetPins(form, ["newPin", "confirmPin"])
    const result = await setTransactionPin({ pin: newPin, password })
    if (result.ok) return onSet(newPin)
    if (result.code === "PASSWORD_NOT_SET") return setNoPassword(true)
    if (result.code === "TRANSACTION_PIN_ALREADY_SET" && onAlreadySet) return onAlreadySet()
    if (result.code === "INCORRECT_PASSWORD") return form.setError("password", { message: result.error }, { shouldFocus: true })
    if (result.code === "WEAK_TRANSACTION_PIN") return form.setError("newPin", { message: result.error }, { shouldFocus: true })
    applyResult(form, result)
  }

  if (noPassword) return <NoPasswordNotice onCancel={onCancel} cancelLabel={cancelLabel} />

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid gap-6">
      <FormError message={errors.root?.message} />
      <FieldGroup>
        <PasswordField form={form} id={`${idPrefix}-password`} autoFocus />
        <NewPinFields form={form} idPrefix={idPrefix} />
      </FieldGroup>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={isSubmitting}>
          {cancelLabel}
        </Button>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting && <Spinner />}
          {submitLabel}
        </Button>
      </DialogFooter>
    </form>
  )
}

/** A new PIN, proven with the current PIN or the password. A locked PIN can only be reset. */
export function ChangePinForm({
  idPrefix,
  submitLabel,
  onCancel,
  cancelLabel = "Cancel",
  hasPassword,
  onChanged,
  onLocked,
}: FormProps & {
  hasPassword: boolean
  onChanged: () => void
  /** A wrong current PIN used the last try. */
  onLocked: (lockedUntil: string | null) => void
}) {
  const form = useForm<ChangePinValues>({
    resolver: zodResolver(changePinSchema),
    reValidateMode: "onBlur",
    defaultValues: { proof: "pin", currentPin: "", password: "", newPin: "", confirmPin: "" },
  })
  const { isSubmitting, errors } = form.formState
  const proof = useWatch({ control: form.control, name: "proof" })

  async function onSubmit(values: ChangePinValues) {
    forgetPins(form, ["currentPin", "newPin", "confirmPin"])
    const result = await changeTransactionPin(
      values.proof === "pin" ? { newPin: values.newPin, currentPin: values.currentPin } : { newPin: values.newPin, password: values.password },
    )
    if (result.ok) return onChanged()
    if (result.code === "TRANSACTION_PIN_LOCKED") return onLocked(result.lockedUntil ?? result.retryAt ?? null)
    if (result.code === "TRANSACTION_PIN_INVALID")
      return form.setError("currentPin", { message: wrongPinMessage(result.attemptsLeft) }, { shouldFocus: true })
    if (result.code === "INCORRECT_PASSWORD") return form.setError("password", { message: result.error }, { shouldFocus: true })
    if (result.code === "WEAK_TRANSACTION_PIN") return form.setError("newPin", { message: result.error }, { shouldFocus: true })
    applyResult(form, result)
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid gap-6">
      <FormError message={errors.root?.message} />
      {hasPassword && (
        <div role="radiogroup" aria-label="Confirm it's you with" className="inline-flex h-9 w-fit items-center gap-0.5 rounded-full bg-muted p-0.5">
          {(["pin", "password"] as const).map((v) => (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={proof === v}
              onClick={() => {
                form.setValue("proof", v)
                form.clearErrors()
              }}
              className={cn(
                "h-8 rounded-full px-4 text-sm font-medium transition-colors duration-150 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                proof === v ? "bg-card text-foreground shadow-surface" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {v === "pin" ? "Current PIN" : "Password"}
            </button>
          ))}
        </div>
      )}
      <FieldGroup>
        {proof === "pin" ? (
          <Controller
            name="currentPin"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor={`${idPrefix}-current-pin`}>Current PIN</FieldLabel>
                <PinInput
                  id={`${idPrefix}-current-pin`}
                  ref={field.ref}
                  value={field.value}
                  onChange={field.onChange}
                  onComplete={() => form.setFocus("newPin")}
                  invalid={fieldState.invalid}
                  autoFocus
                />
                {fieldState.error ? (
                  <FieldError errors={[fieldState.error]} />
                ) : (
                  hasPassword && <FieldDescription>Forgotten it? Use your password instead.</FieldDescription>
                )}
              </Field>
            )}
          />
        ) : (
          <PasswordField form={form} id={`${idPrefix}-password`} autoFocus />
        )}
        <NewPinFields form={form} idPrefix={idPrefix} />
      </FieldGroup>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={isSubmitting}>
          {cancelLabel}
        </Button>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting && <Spinner />}
          {submitLabel}
        </Button>
      </DialogFooter>
    </form>
  )
}

/** A forgotten or locked PIN: we email a code, then the code, the password and the new PIN twice. */
export function ResetPinForm({
  idPrefix,
  submitLabel,
  onCancel,
  cancelLabel = "Cancel",
  onReset,
}: FormProps & {
  /** After the PIN is reset, with the new PIN, so a confirmation can carry straight on with it. */
  onReset: (pin: string) => void | Promise<void>
}) {
  const [sent, setSent] = useState<{ to?: string; cooling: boolean } | null>(null)
  const [requestError, setRequestError] = useState<string>()
  const [noPassword, setNoPassword] = useState(false)
  const [requesting, startRequest] = useTransition()
  const form = useForm<ResetPinValues>({
    resolver: zodResolver(resetPinSchema),
    reValidateMode: "onBlur",
    defaultValues: { code: "", password: "", newPin: "", confirmPin: "" },
  })
  const { isSubmitting, errors } = form.formState

  function request() {
    setRequestError(undefined)
    startRequest(async () => {
      const result = await requestTransactionPinReset()
      if (result.ok) setSent({ to: result.data.sentTo, cooling: true })
      // One code a minute: the last one is still good, so go on to enter it.
      else if (result.code === "OTP_COOLDOWN") setSent({ cooling: true })
      else setRequestError(result.error)
    })
  }

  async function resend(): Promise<ActionResult> {
    const result = await requestTransactionPinReset()
    return result.ok ? { ok: true, data: undefined } : result
  }

  async function onSubmit({ code, password, newPin }: ResetPinValues) {
    forgetPins(form, ["newPin", "confirmPin"])
    const result = await resetTransactionPin({ code, password, newPin })
    if (result.ok) return onReset(newPin)
    if (result.code === "PASSWORD_NOT_SET") return setNoPassword(true)
    if (result.code === "INVALID_CODE") {
      form.setValue("code", "")
      return form.setError("code", { message: result.error }, { shouldFocus: true })
    }
    if (result.code === "INCORRECT_PASSWORD") return form.setError("password", { message: result.error }, { shouldFocus: true })
    if (result.code === "WEAK_TRANSACTION_PIN") return form.setError("newPin", { message: result.error }, { shouldFocus: true })
    applyResult(form, result)
  }

  if (noPassword) return <NoPasswordNotice onCancel={onCancel} cancelLabel={cancelLabel} />

  if (!sent) {
    return (
      <div className="grid gap-6">
        <FormError message={requestError} />
        <p className="text-sm text-muted-foreground">
          We&apos;ll email you a 6-digit code. You&apos;ll enter it with your password, then choose a new PIN.
        </p>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel} disabled={requesting}>
            {cancelLabel}
          </Button>
          <Button type="button" onClick={request} disabled={requesting}>
            {requesting && <Spinner />}
            Email me a code
          </Button>
        </DialogFooter>
      </div>
    )
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid gap-6">
      <p className="text-sm text-muted-foreground">
        {sent.to ? (
          <>
            We sent a code to <span className="font-medium text-foreground">{sent.to}</span>. It expires in 10 minutes.
          </>
        ) : (
          "We sent you a code less than a minute ago. Use that one, or ask for another in a moment."
        )}
      </p>
      <FormError message={errors.root?.message} />
      <FieldGroup>
        <Controller
          name="code"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor={`${idPrefix}-code`}>Code from the email</FieldLabel>
              <CodeInput
                id={`${idPrefix}-code`}
                value={field.value}
                onChange={field.onChange}
                onComplete={() => form.setFocus("password")}
                disabled={isSubmitting}
                invalid={fieldState.invalid}
              />
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />
        <PasswordField form={form} id={`${idPrefix}-password`} />
        <NewPinFields form={form} idPrefix={idPrefix} />
      </FieldGroup>
      <ResendButton onResend={resend} startCoolingDown={sent.cooling} />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={isSubmitting}>
          {cancelLabel}
        </Button>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting && <Spinner />}
          {submitLabel}
        </Button>
      </DialogFooter>
    </form>
  )
}
