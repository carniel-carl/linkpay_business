"use client"

import { useState } from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { UserPlus } from "lucide-react"
import { Controller, useForm } from "react-hook-form"
import { toast } from "sonner"
import { inviteMember } from "@/app/(dashboard)/team/actions"
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
import type { BranchRef, RoleInfo, RolesResponse } from "@/lib/api/types"
import { applyResult } from "@/lib/forms"
import { inviteSchema, type InviteValues } from "@/lib/schemas"
import { AccessFields } from "./access-fields"

type Props = {
  roles: RoleInfo[]
  catalog: RolesResponse["permissions"]
  branches: BranchRef[]
  adminHidden: boolean
}

/** Invites someone by email. The link lasts 7 days; new people sign up straight from it. */
export function InviteDialog({ roles, catalog, branches, adminHidden }: Props) {
  const [open, setOpen] = useState(false)
  // The least-privileged role is the safest default.
  const defaults = (): InviteValues => ({ email: "", role: roles.at(-1)?.role ?? "", allBranches: true, branches: [] })
  const form = useForm<InviteValues>({ resolver: zodResolver(inviteSchema), defaultValues: defaults() })
  const { isSubmitting, errors } = form.formState

  async function onSubmit(values: InviteValues) {
    const result = await inviteMember(values)
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
          Invite someone
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Invite a team member</DialogTitle>
          <DialogDescription>
            We&apos;ll email them a link to join. They sign in with their own account, and their role decides what they
            can see and do.
          </DialogDescription>
        </DialogHeader>

        <form id="invite-form" onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid gap-6">
          {/* Email problems show under the field; this is for everything else. */}
          <FormError message={errors.root?.message} />
          <Controller
            name="email"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="invite-email">Email</FieldLabel>
                <Input
                  id="invite-email"
                  type="email"
                  inputMode="email"
                  autoComplete="off"
                  placeholder="tunde@yourbusiness.ng"
                  aria-invalid={fieldState.invalid}
                  {...field}
                />
                {fieldState.error && <FieldError errors={[fieldState.error]} />}
              </Field>
            )}
          />
          <AccessFields
            form={form}
            roles={roles}
            catalog={catalog}
            branches={branches}
            adminHidden={adminHidden}
            idPrefix="invite"
          />
        </form>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={isSubmitting}>
              Cancel
            </Button>
          </DialogClose>
          <Button type="submit" form="invite-form" disabled={isSubmitting}>
            {isSubmitting && <Spinner />}
            Send invite
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
