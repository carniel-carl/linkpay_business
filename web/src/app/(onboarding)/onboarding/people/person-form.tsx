"use client"

import { zodResolver } from "@hookform/resolvers/zod"
import { Controller, useForm } from "react-hook-form"
import { toast } from "sonner"
import { FormError } from "@/components/common/form-error"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { SheetClose, SheetFooter } from "@/components/ui/sheet"
import { Spinner } from "@/components/ui/spinner"
import type { Person } from "@/lib/api/types"
import { applyResult } from "@/lib/forms"
import { maskBVN } from "@/lib/format"
import { ID_TYPE_LABELS, ID_TYPES, PERSON_ROLES, ROLE_LABELS } from "@/lib/kyb"
import { personSchema, type PersonValues } from "@/lib/schemas"
import { addPerson, updatePerson } from "../actions"

export function PersonForm({ person, onDone }: { person?: Person; onDone: () => void }) {
  const form = useForm<PersonValues>({
    resolver: zodResolver(personSchema),
    defaultValues: {
      fullName: person?.fullName ?? "",
      roles: person?.roles ?? [],
      email: person?.email ?? "",
      phone: person?.phone ?? "",
      ownershipPercent: person?.ownershipPercent !== undefined ? String(person.ownershipPercent) : "",
      idType: person?.idType,
      bvn: "",
    },
  })
  const { isSubmitting, errors } = form.formState

  async function onSubmit(values: PersonValues) {
    // A BVN is only optional when editing someone who already has one.
    if (!values.bvn && !person?.bvnLast4) {
      form.setError("bvn", { message: "Enter their 11-digit BVN." })
      return
    }
    const result = person ? await updatePerson(person._id, values) : await addPerson(values)
    if (applyResult(form, result)) {
      toast.success(person ? "Changes saved." : `${values.fullName} added. Upload their ID next.`)
      onDone()
    }
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="flex flex-1 flex-col">
      <div className="grid gap-6 p-4">
        <FormError message={errors.root?.message} />
        <FieldGroup>
          <Controller
            name="fullName"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="fullName">Full name</FieldLabel>
                <Input id="fullName" autoComplete="off" aria-invalid={fieldState.invalid} {...field} />
                <FieldError errors={[fieldState.error]} />
              </Field>
            )}
          />

          <Controller
            name="roles"
            control={form.control}
            render={({ field, fieldState }) => (
              <FieldSet data-invalid={fieldState.invalid}>
                <FieldLegend variant="label">Roles</FieldLegend>
                <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                  {PERSON_ROLES.map((role) => (
                    <Field key={role} orientation="horizontal">
                      <Checkbox
                        id={`role-${role}`}
                        checked={field.value.includes(role)}
                        aria-invalid={fieldState.invalid}
                        onCheckedChange={(checked) =>
                          field.onChange(checked ? [...field.value, role] : field.value.filter((r) => r !== role))
                        }
                      />
                      <FieldLabel htmlFor={`role-${role}`} className="font-normal">
                        {ROLE_LABELS[role]}
                      </FieldLabel>
                    </Field>
                  ))}
                </div>
                <FieldError errors={[fieldState.error]} />
              </FieldSet>
            )}
          />

          <Controller
            name="bvn"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="bvn">BVN</FieldLabel>
                <Input
                  id="bvn"
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={11}
                  placeholder={person?.bvnLast4 ? maskBVN(person.bvnLast4) : undefined}
                  className="font-mono tracking-wider"
                  aria-invalid={fieldState.invalid}
                  {...field}
                  onChange={(e) => field.onChange(e.target.value.replace(/\D/g, ""))}
                />
                {fieldState.error ? (
                  <FieldError errors={[fieldState.error]} />
                ) : (
                  <FieldDescription>
                    11 digits. Dial *565*0# from the phone linked to their bank account to check it.
                  </FieldDescription>
                )}
              </Field>
            )}
          />

          <Controller
            name="idType"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="idType">ID they&apos;ll upload</FieldLabel>
                <Select name={field.name} value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="idType" className="w-full" aria-invalid={fieldState.invalid}>
                    <SelectValue placeholder="Choose an ID type" />
                  </SelectTrigger>
                  <SelectContent>
                    {ID_TYPES.map((t) => (
                      <SelectItem key={t} value={t}>
                        {ID_TYPE_LABELS[t]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldError errors={[fieldState.error]} />
              </Field>
            )}
          />

          <div className="grid gap-5 sm:grid-cols-2">
            <Controller
              name="phone"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="phone">Phone</FieldLabel>
                  <Input id="phone" type="tel" inputMode="tel" aria-invalid={fieldState.invalid} {...field} />
                  {fieldState.error ? <FieldError errors={[fieldState.error]} /> : <FieldDescription>Optional.</FieldDescription>}
                </Field>
              )}
            />
            <Controller
              name="ownershipPercent"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="ownershipPercent">Ownership (%)</FieldLabel>
                  <Input id="ownershipPercent" inputMode="decimal" className="figure" aria-invalid={fieldState.invalid} {...field} />
                  {fieldState.error ? <FieldError errors={[fieldState.error]} /> : <FieldDescription>Optional.</FieldDescription>}
                </Field>
              )}
            />
          </div>

          <Controller
            name="email"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="personEmail">Email</FieldLabel>
                <Input id="personEmail" type="email" aria-invalid={fieldState.invalid} {...field} />
                {fieldState.error ? <FieldError errors={[fieldState.error]} /> : <FieldDescription>Optional.</FieldDescription>}
              </Field>
            )}
          />
        </FieldGroup>
      </div>

      <SheetFooter className="mt-auto flex-row justify-end border-t">
        <SheetClose asChild>
          <Button type="button" variant="outline">
            Cancel
          </Button>
        </SheetClose>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting && <Spinner />}
          {person ? "Save changes" : "Add person"}
        </Button>
      </SheetFooter>
    </form>
  )
}
