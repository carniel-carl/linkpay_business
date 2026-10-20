"use client"

import { useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { zodResolver } from "@hookform/resolvers/zod"
import { ArrowLeft, ArrowRight, Check } from "lucide-react"
import { Controller, useForm, type FieldPath } from "react-hook-form"
import { FormError } from "@/components/common/form-error"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { applyResult } from "@/lib/forms"
import { INDUSTRIES, NIGERIAN_STATES } from "@/lib/kyb"
import { businessDetailsSchema, type BusinessDetailsValues } from "@/lib/schemas"
import { updateBusiness } from "../actions"
import Link from "next/link"

type Name = FieldPath<BusinessDetailsValues>
type SaveState = "idle" | "saving" | "saved" | "error"

export function DetailsForm({ defaults }: { defaults: BusinessDetailsValues }) {
  const router = useRouter()
  const form = useForm<BusinessDetailsValues>({
    resolver: zodResolver(businessDetailsSchema),
    defaultValues: defaults,
    mode: "onTouched",
  })
  const [saveState, setSaveState] = useState<SaveState>("idle")
  const lastSaved = useRef<Record<string, string>>(flatten(defaults))
  const { isSubmitting, errors } = form.formState

  /** Autosave one field when it's valid and has changed since the last save. */
  async function autosave(name: Name) {
    const value = String(form.getValues(name) ?? "").trim()
    if (value === "" || lastSaved.current[name] === value) return
    if (!(await form.trigger(name))) return
    setSaveState("saving")
    const patch = name.startsWith("address.")
      ? { address: { [name.slice("address.".length)]: value } }
      : { [name]: value }
    const result = await updateBusiness(patch)
    if (result.ok) {
      lastSaved.current[name] = value
      setSaveState("saved")
    } else {
      setSaveState("error")
      applyResult(form, result)
    }
  }

  async function onSubmit(values: BusinessDetailsValues) {
    const result = await updateBusiness(values)
    if (applyResult(form, result)) router.push("/onboarding/people")
  }

  const text = (name: Name, label: string, opts: { description?: string; type?: string; autoComplete?: string; inputMode?: "numeric" | "tel" | "email" | "url"; mono?: boolean } = {}) => (
    <Controller
      name={name}
      control={form.control}
      render={({ field, fieldState }) => (
        <Field data-invalid={fieldState.invalid}>
          <FieldLabel htmlFor={name}>{label}</FieldLabel>
          <Input
            id={name}
            type={opts.type ?? "text"}
            autoComplete={opts.autoComplete ?? "off"}
            inputMode={opts.inputMode}
            aria-invalid={fieldState.invalid}
            className={opts.mono ? "font-mono" : undefined}
            {...field}
            value={(field.value as string) ?? ""}
            onBlur={() => {
              field.onBlur()
              void autosave(name)
            }}
          />
          {fieldState.error ? (
            <FieldError errors={[fieldState.error]} />
          ) : (
            opts.description && <FieldDescription>{opts.description}</FieldDescription>
          )}
        </Field>
      )}
    />
  )

  const select = (name: Name, label: string, options: readonly string[], placeholder: string) => (
    <Controller
      name={name}
      control={form.control}
      render={({ field, fieldState }) => (
        <Field data-invalid={fieldState.invalid}>
          <FieldLabel htmlFor={name}>{label}</FieldLabel>
          <Select
            name={field.name}
            value={(field.value as string) || undefined}
            onValueChange={(v) => {
              field.onChange(v)
              void autosave(name)
            }}
          >
            <SelectTrigger id={name} className="w-full" aria-invalid={fieldState.invalid} onBlur={field.onBlur}>
              <SelectValue placeholder={placeholder} />
            </SelectTrigger>
            <SelectContent>
              {options.map((o) => (
                <SelectItem key={o} value={o}>
                  {o}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldError errors={[fieldState.error]} />
        </Field>
      )}
    />
  )

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid gap-10">
      <FormError message={errors.root?.message} />

      <FieldSet>
        <FieldLegend>Registration</FieldLegend>
        <FieldGroup className="grid gap-5 sm:grid-cols-2">
          <div className="sm:col-span-2">{text("name", "Registered business name", { autoComplete: "organization" })}</div>
          {text("registrationNumber", "RC or BN number", { description: "From your CAC certificate, e.g. RC 1234567.", mono: true })}
          {text("tin", "Tax Identification Number (TIN)", { description: "Issued by FIRS. 8 to 14 digits.", mono: true })}
          {select("industry", "Industry", INDUSTRIES, "Choose an industry")}
        </FieldGroup>
      </FieldSet>

      <FieldSet>
        <FieldLegend>Contact and address</FieldLegend>
        <FieldGroup className="grid gap-5 sm:grid-cols-2">
          {text("phone", "Business phone", { type: "tel", autoComplete: "tel", inputMode: "tel", description: "e.g. 0803 123 4567" })}
          {text("email", "Business email", { type: "email", autoComplete: "email", description: "Optional." })}
          <div className="sm:col-span-2">
            {text("address.street", "Street address", { autoComplete: "street-address" })}
          </div>
          {text("address.city", "City or town", { autoComplete: "address-level2" })}
          {select("address.state", "State", NIGERIAN_STATES, "Choose a state")}
          <div className="sm:col-span-2">
            {text("website", "Website", { type: "url", inputMode: "url", autoComplete: "url", description: "Optional." })}
          </div>
        </FieldGroup>
      </FieldSet>

      <FieldSet>
        <FieldLegend>About the business</FieldLegend>
        <Controller
          name="description"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="description">What does the business do?</FieldLabel>
              <Textarea
                id="description"
                rows={3}
                aria-invalid={fieldState.invalid}
                {...field}
                value={field.value ?? ""}
                onBlur={() => {
                  field.onBlur()
                  void autosave("description")
                }}
              />
              {fieldState.error ? (
                <FieldError errors={[fieldState.error]} />
              ) : (
                <FieldDescription>Optional. One or two sentences about what you sell and who to.</FieldDescription>
              )}
            </Field>
          )}
        />
      </FieldSet>

      <div className="flex items-center justify-between gap-4 border-t pt-6">
        <Button variant="ghost" asChild>
          <Link href="/onboarding">
            <ArrowLeft data-icon="inline-start" aria-hidden />
            Back
          </Link>
        </Button>
        <div className="flex items-center gap-4">
          <SaveIndicator state={saveState} />
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting && <Spinner />}
            Save and continue
            {!isSubmitting && <ArrowRight data-icon="inline-end" aria-hidden />}
          </Button>
        </div>
      </div>
    </form>
  )
}

function SaveIndicator({ state }: { state: SaveState }) {
  return (
    <span className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex" aria-live="polite">
      {state === "saving" && (
        <>
          <Spinner className="size-3" /> Saving
        </>
      )}
      {state === "saved" && (
        <>
          <Check className="size-3.5 text-primary" aria-hidden /> Saved
        </>
      )}
      {state === "error" && <span className="text-destructive">Not saved</span>}
    </span>
  )
}

function flatten(values: BusinessDetailsValues): Record<string, string> {
  const { address, ...rest } = values
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(rest)) out[k] = String(v ?? "")
  for (const [k, v] of Object.entries(address)) out[`address.${k}`] = String(v ?? "")
  return out
}
