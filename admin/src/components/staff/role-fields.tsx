"use client"

import { Controller, type Control, type FieldValues, type Path } from "react-hook-form"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from "@/components/ui/field"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import type { StaffRoleInfo } from "@/lib/api/types"

/** One card per staff role, with what it allows. */
export function RoleFields<T extends FieldValues & { role: string }>({
  control,
  roles,
  idPrefix,
}: {
  control: Control<T>
  roles: StaffRoleInfo[]
  idPrefix: string
}) {
  return (
    <Controller
      name={"role" as Path<T>}
      control={control}
      render={({ field, fieldState }) => (
        <FieldSet data-invalid={fieldState.invalid}>
          <FieldLegend variant="label">Role</FieldLegend>
          <RadioGroup value={field.value} onValueChange={field.onChange} aria-invalid={fieldState.invalid}>
            {roles.map((r) => (
              <FieldLabel key={r.role} htmlFor={`${idPrefix}-role-${r.role}`}>
                <Field orientation="horizontal">
                  <FieldContent>
                    <FieldTitle>{r.label}</FieldTitle>
                    <FieldDescription className="text-xs">{r.description}</FieldDescription>
                  </FieldContent>
                  <RadioGroupItem value={r.role} id={`${idPrefix}-role-${r.role}`} />
                </Field>
              </FieldLabel>
            ))}
          </RadioGroup>
          {fieldState.error && <FieldError errors={[fieldState.error]} />}
        </FieldSet>
      )}
    />
  )
}
