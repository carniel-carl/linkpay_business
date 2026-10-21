"use client"

import { useState } from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { UserPlus } from "lucide-react"
import { Controller, useForm } from "react-hook-form"
import { toast } from "sonner"
import { inviteStaff } from "@/app/(console)/staff/actions"
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
import { Field, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import type { StaffRoleInfo } from "@/lib/api/types"
import { applyResult } from "@/lib/forms"
import { staffInviteSchema, type StaffInviteValues } from "@/lib/schemas"
import { RoleFields } from "./role-fields"

/** Invites someone to the staff console by email. The link lasts 7 days. */
export function InviteStaffDialog({ roles }: { roles: StaffRoleInfo[] }) {
  const [open, setOpen] = useState(false)
  // The least-privileged role (listed last) is the safest default.
  const defaults = (): StaffInviteValues => ({ email: "", role: roles.at(-1)?.role ?? "" })
  const form = useForm<StaffInviteValues>({ resolver: zodResolver(staffInviteSchema), defaultValues: defaults() })
  const { isSubmitting, errors } = form.formState

  async function onSubmit(values: StaffInviteValues) {
    const result = await inviteStaff(values)
    if (!applyResult(form, result)) return
    setOpen(false)
    form.reset(defaults())
    toast.success(`Invite sent to ${result.data.email}. The link works for 7 days.`)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) form.reset(defaults())
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <UserPlus data-icon="inline-start" aria-hidden />
          Invite staff
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Invite a member of staff</DialogTitle>
          <DialogDescription>
            We&apos;ll email them a link to set up their staff sign-in. Their role decides what they can see and do in
            the console.
          </DialogDescription>
        </DialogHeader>

        <form id="invite-staff-form" onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid gap-6">
          <FormError message={errors.root?.message} />
          <Controller
            name="email"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="invite-email">Work email</FieldLabel>
                <Input
                  id="invite-email"
                  type="email"
                  inputMode="email"
                  autoComplete="off"
                  placeholder="ada@linkpay.ng"
                  aria-invalid={fieldState.invalid}
                  {...field}
                />
                {fieldState.error && <FieldError errors={[fieldState.error]} />}
              </Field>
            )}
          />
          <RoleFields control={form.control} roles={roles} idPrefix="invite" />
        </form>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={isSubmitting}>
              Cancel
            </Button>
          </DialogClose>
          <Button type="submit" form="invite-staff-form" disabled={isSubmitting}>
            {isSubmitting && <Spinner />}
            Send invite
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
