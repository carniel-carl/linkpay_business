"use client"

import { Controller, useWatch, type Path, type PathValue, type UseFormReturn } from "react-hook-form"
import { Checkbox } from "@/components/ui/checkbox"
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
import type { BranchRef, RoleInfo, RolesResponse } from "@/lib/api/types"
import { describeRole } from "@/lib/permissions"
import type { AccessValues } from "@/lib/schemas"

type Props<T extends AccessValues> = {
  form: UseFormReturn<T>
  /** Roles the signed-in member may give (see grantableRoles). */
  roles: RoleInfo[]
  catalog: RolesResponse["permissions"]
  branches: BranchRef[]
  /** Explains why admin is missing from the list. */
  adminHidden: boolean
  idPrefix: string
  /** Branches only (the role stays as it is). */
  hideRole?: boolean
}

/** Role cards with what each can do, then branch access for roles that can be limited to branches. */
export function AccessFields<T extends AccessValues>({
  form,
  roles,
  catalog,
  branches,
  adminHidden,
  idPrefix,
  hideRole,
}: Props<T>) {
  const name = (n: keyof AccessValues) => n as Path<T>
  const set = <K extends keyof AccessValues>(n: K, value: AccessValues[K]) =>
    form.setValue(name(n), value as PathValue<T, Path<T>>, { shouldDirty: true, shouldValidate: form.formState.isSubmitted })

  const role = useWatch({ control: form.control, name: name("role") }) as string
  const allBranches = useWatch({ control: form.control, name: name("allBranches") }) as boolean
  const chosen = roles.find((r) => r.role === role)
  // With one branch, "all" and "that one" are the same thing, so there's nothing to choose.
  const branchChoice = !!chosen && !chosen.businessWide && branches.length > 1

  return (
    <>
      {!hideRole && (
        <Controller
          name={name("role")}
          control={form.control}
          render={({ field, fieldState }) => (
            <FieldSet data-invalid={fieldState.invalid}>
              <FieldLegend variant="label">Role</FieldLegend>
              <RadioGroup
                value={field.value as string}
                onValueChange={(value) => {
                  field.onChange(value)
                  // Business-wide roles always cover every branch.
                  if (roles.find((r) => r.role === value)?.businessWide) set("allBranches", true)
                }}
                aria-invalid={fieldState.invalid}
              >
                {roles.map((r) => (
                  <FieldLabel key={r.role} htmlFor={`${idPrefix}-role-${r.role}`}>
                    <Field orientation="horizontal">
                      <FieldContent>
                        <FieldTitle>{r.label}</FieldTitle>
                        <FieldDescription className="text-xs">{describeRole(r, catalog)}</FieldDescription>
                      </FieldContent>
                      <RadioGroupItem value={r.role} id={`${idPrefix}-role-${r.role}`} />
                    </Field>
                  </FieldLabel>
                ))}
              </RadioGroup>
              {adminHidden && <FieldDescription>Only the business owner can make someone an admin.</FieldDescription>}
              {fieldState.error && <FieldError errors={[fieldState.error]} />}
            </FieldSet>
          )}
        />
      )}

      {chosen?.businessWide && branches.length > 1 && (
        <p className="rounded-lg bg-muted/70 px-3 py-2.5 text-sm text-muted-foreground">
          {chosen.label} access covers every branch, including ones you add later.
        </p>
      )}

      {branchChoice && (
        <Controller
          name={name("branches")}
          control={form.control}
          render={({ field, fieldState }) => {
            const selected = field.value as string[]
            const toggle = (id: string, on: boolean) =>
              field.onChange(on ? [...selected, id] : selected.filter((b) => b !== id))
            return (
              <FieldSet data-invalid={fieldState.invalid}>
                <FieldLegend variant="label">Branches</FieldLegend>
                <div className="grid gap-1 rounded-xl border p-1.5">
                  <Field orientation="horizontal" className="rounded-lg px-2.5 py-2">
                    <Checkbox
                      id={`${idPrefix}-all-branches`}
                      checked={allBranches}
                      onCheckedChange={(on) => set("allBranches", on === true)}
                    />
                    <FieldContent>
                      <FieldLabel htmlFor={`${idPrefix}-all-branches`}>All branches</FieldLabel>
                      <FieldDescription className="text-xs">Includes branches you add later.</FieldDescription>
                    </FieldContent>
                  </Field>
                  {!allBranches && (
                    <div className="grid gap-0.5 border-t pt-1.5">
                      {branches.map((b) => (
                        <Field key={b._id} orientation="horizontal" className="rounded-lg px-2.5 py-2">
                          <Checkbox
                            id={`${idPrefix}-branch-${b._id}`}
                            checked={selected.includes(b._id)}
                            onCheckedChange={(on) => toggle(b._id, on === true)}
                            aria-invalid={fieldState.invalid}
                          />
                          <FieldLabel htmlFor={`${idPrefix}-branch-${b._id}`} className="font-normal">
                            {b.name}
                            {b.isHeadOffice && b.name !== "Head office" && (
                              <span className="text-xs text-muted-foreground">Head office</span>
                            )}
                          </FieldLabel>
                        </Field>
                      ))}
                    </div>
                  )}
                </div>
                {fieldState.error && <FieldError errors={[fieldState.error]} />}
              </FieldSet>
            )
          }}
        />
      )}
    </>
  )
}
