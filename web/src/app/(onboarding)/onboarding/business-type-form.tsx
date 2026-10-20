"use client"

import { useRouter } from "next/navigation"
import { zodResolver } from "@hookform/resolvers/zod"
import { ArrowRight, Info } from "lucide-react"
import { Controller, useForm, useWatch } from "react-hook-form"
import type { z } from "zod"
import { FormError } from "@/components/common/form-error"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Spinner } from "@/components/ui/spinner"
import { applyResult } from "@/lib/forms"
import { BUSINESS_TYPE_INFO, BUSINESS_TYPES } from "@/lib/kyb"
import { createBusinessSchema } from "@/lib/schemas"
import { createBusiness, updateBusiness } from "./actions"

type Values = z.infer<typeof createBusinessSchema>

export function BusinessTypeForm({ business }: { business?: Values }) {
  const router = useRouter()
  const form = useForm<Values>({
    resolver: zodResolver(createBusinessSchema),
    defaultValues: business ?? { name: "", type: undefined as unknown as Values["type"] },
  })
  const { isSubmitting, errors, isDirty } = form.formState
  const type = useWatch({ control: form.control, name: "type" })
  const typeChanged = !!business && type !== business.type

  async function onSubmit(values: Values) {
    if (business && !isDirty) return router.push("/onboarding/details")
    const result = business ? await updateBusiness(values) : await createBusiness(values)
    if (applyResult(form, result)) router.push("/onboarding/details")
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid gap-8">
      <FormError message={errors.root?.message} />
      <FieldGroup>
        <Controller
          name="name"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="name">Registered business name</FieldLabel>
              <Input id="name" autoComplete="organization" aria-invalid={fieldState.invalid} {...field} />
              {fieldState.error ? (
                <FieldError errors={[fieldState.error]} />
              ) : (
                <FieldDescription>Exactly as it appears on your CAC certificate.</FieldDescription>
              )}
            </Field>
          )}
        />

        <Controller
          name="type"
          control={form.control}
          render={({ field, fieldState }) => (
            <FieldSet data-invalid={fieldState.invalid}>
              <FieldLegend variant="label">Registration type</FieldLegend>
              <RadioGroup
                name={field.name}
                value={field.value ?? ""}
                onValueChange={field.onChange}
                aria-invalid={fieldState.invalid}
                className="grid gap-2 sm:grid-cols-2"
              >
                {BUSINESS_TYPES.map((t) => (
                  <FieldLabel key={t} htmlFor={`type-${t}`} className="*:data-[slot=field]:p-3.5">
                    <Field orientation="horizontal">
                      <FieldContent>
                        <FieldTitle>{BUSINESS_TYPE_INFO[t].label}</FieldTitle>
                        <FieldDescription className="text-xs">{BUSINESS_TYPE_INFO[t].hint}</FieldDescription>
                      </FieldContent>
                      <RadioGroupItem value={t} id={`type-${t}`} />
                    </Field>
                  </FieldLabel>
                ))}
              </RadioGroup>
              <FieldError errors={[fieldState.error]} />
            </FieldSet>
          )}
        />
      </FieldGroup>

      {typeChanged && (
        <p className="flex gap-2 text-sm text-muted-foreground">
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
          Changing the type changes which documents and people we need. Anything you&apos;ve uploaded stays saved.
        </p>
      )}

      <div className="flex justify-end border-t pt-6">
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting && <Spinner />}
          {business ? "Save and continue" : "Continue"}
          {!isSubmitting && <ArrowRight data-icon="inline-end" aria-hidden />}
        </Button>
      </div>
    </form>
  )
}
