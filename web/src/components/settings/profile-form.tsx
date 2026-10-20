"use client"

import { zodResolver } from "@hookform/resolvers/zod"
import { Controller, useForm } from "react-hook-form"
import { toast } from "sonner"
import { z } from "zod"
import { updateName } from "@/app/(dashboard)/settings/actions"
import { FormError } from "@/components/common/form-error"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { applyResult } from "@/lib/forms"

const schema = z.object({ name: z.string().trim().min(1, "Enter your full name.") })
type Values = z.infer<typeof schema>

export function ProfileForm({ name }: { name: string }) {
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { name } })
  const { isSubmitting, isDirty, errors } = form.formState

  async function onSubmit(values: Values) {
    const result = await updateName(values)
    if (applyResult(form, result)) {
      form.reset(values)
      toast.success("Name updated.")
    }
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid gap-4">
      <h2 className="text-sm font-medium">Your details</h2>
      <FormError message={errors.root?.message} />
      <Controller
        name="name"
        control={form.control}
        render={({ field, fieldState }) => (
          <Field data-invalid={fieldState.invalid} className="max-w-sm">
            <FieldLabel htmlFor="name">Full name</FieldLabel>
            <Input id="name" autoComplete="name" aria-invalid={fieldState.invalid} {...field} />
            {fieldState.error ? (
              <FieldError errors={[fieldState.error]} />
            ) : (
              <FieldDescription>Shown to your team and on emails we send you.</FieldDescription>
            )}
          </Field>
        )}
      />
      <Button type="submit" className="w-fit" disabled={isSubmitting || !isDirty}>
        {isSubmitting && <Spinner />}
        Save
      </Button>
    </form>
  )
}
