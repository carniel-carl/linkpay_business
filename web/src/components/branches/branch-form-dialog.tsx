"use client"

import { useState } from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { Controller, useForm } from "react-hook-form"
import { toast } from "sonner"
import { createBranch, updateBranch } from "@/app/(dashboard)/branches/actions"
import { FormError } from "@/components/common/form-error"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { NativeSelect } from "@/components/ui/native-select"
import { Spinner } from "@/components/ui/spinner"
import type { Branch } from "@/lib/api/types"
import { applyResult } from "@/lib/forms"
import { NIGERIAN_STATES } from "@/lib/kyb"
import { branchSchema, type BranchValues } from "@/lib/schemas"

type TextField = "name" | "address.street" | "address.city" | "manager.name" | "manager.email" | "manager.phone"

/*
 * Autofill. Chrome ignores autocomplete="off" on address forms, so without hints it offered the
 * signed-in person's saved address from the Branch name field, and filled their own name and
 * contact details into the branch and manager fields. Picking that suggestion crashed the tab
 * ("Aw, Snap!", error code 11, a Chrome renderer crash); the likely trigger was autofill filling
 * Radix Select's visually hidden native <select> (not reproducible through DevTools autofill).
 * Now: the address fields use standard tokens in their own section, the state is a real <select>,
 * and fields that must never take the user's own details use a token Chrome doesn't recognise,
 * which it treats as "don't autofill".
 */
const NO_AUTOFILL = "nope"

function defaults(branch?: Branch): BranchValues {
  return {
    name: branch?.name ?? "",
    address: {
      street: branch?.address?.street ?? "",
      city: branch?.address?.city ?? "",
      state: branch?.address?.state ?? "",
    },
    manager: {
      name: branch?.manager?.name ?? "",
      email: branch?.manager?.email ?? "",
      phone: branch?.manager?.phone ?? "",
    },
  }
}

/** Add a branch, or edit one when `branch` is given. The trigger is passed as children. */
export function BranchFormDialog({ branch, children }: { branch?: Branch; children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const editing = !!branch
  const form = useForm<BranchValues>({ resolver: zodResolver(branchSchema), defaultValues: defaults(branch) })
  const { isSubmitting, isDirty, errors } = form.formState

  async function onSubmit(values: BranchValues) {
    const result = editing ? await updateBranch(branch._id, values) : await createBranch(values)
    if (!applyResult(form, result)) return
    setOpen(false)
    form.reset(editing ? values : defaults())
    if (editing) toast.success("Branch updated.")
    else if (result.data.account) toast.success(`${result.data.name} is ready: ${result.data.account.accountNumber}`)
    else toast.success(`${result.data.name} added. Its account number will appear here shortly.`)
  }

  const text = (name: TextField, label: string, props: React.ComponentProps<typeof Input> = {}, hint?: string) => (
    <Controller
      name={name}
      control={form.control}
      render={({ field, fieldState }) => (
        <Field data-invalid={fieldState.invalid}>
          <FieldLabel htmlFor={`branch-${name}`}>{label}</FieldLabel>
          <Input id={`branch-${name}`} aria-invalid={fieldState.invalid} {...props} {...field} value={field.value ?? ""} />
          {fieldState.error ? <FieldError errors={[fieldState.error]} /> : hint && <FieldDescription>{hint}</FieldDescription>}
        </Field>
      )}
    />
  )

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        // Reopening starts from the saved values, not a half-edited draft.
        if (!next) form.reset(defaults(branch))
      }}
    >
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit ${branch.name}` : "Add a branch"}</DialogTitle>
          <DialogDescription>
            {editing
              ? "Changes apply straight away. The account number stays the same."
              : "Each branch gets its own account number, so you can see what each location brings in."}
          </DialogDescription>
        </DialogHeader>

        <form id="branch-form" onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid gap-6">
          <FormError message={errors.root?.message} />
          {branch?.isHeadOffice ? (
            <p className="rounded-lg bg-muted/70 px-3 py-2.5 text-sm text-muted-foreground">
              The head office keeps its name. It&apos;s your business&apos;s registered address.
            </p>
          ) : (
            text("name", "Branch name", { autoComplete: NO_AUTOFILL, placeholder: "Ikeja store" }, "Customers don't see this; it's for you and your team.")
          )}

          <FieldSet>
            <FieldLegend variant="label">Address</FieldLegend>
            <FieldGroup className="gap-4">
              {text("address.street", "Street", { autoComplete: "section-branch address-line1" })}
              <div className="grid gap-4 sm:grid-cols-2">
                {text("address.city", "City", { autoComplete: "section-branch address-level2" })}
                <Controller
                  name="address.state"
                  control={form.control}
                  render={({ field, fieldState }) => (
                    <Field data-invalid={fieldState.invalid}>
                      <FieldLabel htmlFor="branch-address.state">State</FieldLabel>
                      <NativeSelect
                        id="branch-address.state"
                        name={field.name}
                        autoComplete="section-branch address-level1"
                        aria-invalid={fieldState.invalid}
                        value={field.value ?? ""}
                        onChange={(e) => field.onChange(e.target.value)}
                        onBlur={field.onBlur}
                        ref={field.ref}
                      >
                        <option value="">Choose a state</option>
                        {NIGERIAN_STATES.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </NativeSelect>
                      {fieldState.error && <FieldError errors={[fieldState.error]} />}
                    </Field>
                  )}
                />
              </div>
            </FieldGroup>
          </FieldSet>

          <FieldSet>
            <FieldLegend variant="label">Branch manager</FieldLegend>
            <FieldDescription className="-mt-1.5">Optional. Contact details only for now; team access comes later.</FieldDescription>
            <FieldGroup className="gap-4">
              {text("manager.name", "Full name", { autoComplete: NO_AUTOFILL })}
              <div className="grid gap-4 sm:grid-cols-2">
                {text("manager.email", "Email", { type: "email", autoComplete: NO_AUTOFILL, inputMode: "email" })}
                {text("manager.phone", "Phone", { type: "tel", autoComplete: NO_AUTOFILL, inputMode: "tel" })}
              </div>
            </FieldGroup>
          </FieldSet>
        </form>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={isSubmitting}>
              Cancel
            </Button>
          </DialogClose>
          <Button type="submit" form="branch-form" disabled={isSubmitting || (editing && !isDirty)}>
            {isSubmitting && <Spinner />}
            {editing ? "Save changes" : "Add branch"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
