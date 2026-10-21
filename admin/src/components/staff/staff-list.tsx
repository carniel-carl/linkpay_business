"use client"

import { useState, useTransition } from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { LogOut, MoreHorizontal, UserCheck, UserCog, UserX } from "lucide-react"
import { useForm } from "react-hook-form"
import { toast } from "sonner"
import { changeStaffRole, disableStaff, enableStaff, signOutStaff } from "@/app/(console)/staff/actions"
import { FormError } from "@/components/common/form-error"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Spinner } from "@/components/ui/spinner"
import type { StaffMember, StaffRoleInfo } from "@/lib/api/types"
import { applyResult } from "@/lib/forms"
import { initials, timeAgo } from "@/lib/format"
import { roleLabel } from "@/lib/permissions"
import { staffRoleSchema, type StaffRoleValues } from "@/lib/schemas"
import { RoleFields } from "./role-fields"

const COLUMNS = "md:grid-cols-[minmax(0,2.2fr)_minmax(0,1.3fr)_6rem_8rem_2.5rem]"

/** Staff accounts, read as a table from md up and as cards below. */
export function StaffList({ staff, roles }: { staff: StaffMember[]; roles: StaffRoleInfo[] }) {
  return (
    <section aria-labelledby="staff-title" className="surface overflow-hidden">
      <div className="flex items-baseline justify-between gap-4 border-b px-6 py-5 sm:px-8">
        <h2 id="staff-title" className="font-display text-lg font-semibold tracking-[-0.02em]">
          Staff
        </h2>
        <span className="text-sm text-muted-foreground figure">
          {staff.length} {staff.length === 1 ? "person" : "people"}
        </span>
      </div>
      <div
        aria-hidden
        className={`hidden gap-4 bg-muted/60 px-8 py-2.5 text-xs font-medium text-muted-foreground md:grid ${COLUMNS}`}
      >
        <span>Member</span>
        <span>Role</span>
        <span>Status</span>
        <span>Last signed in</span>
        <span />
      </div>
      <ul className="divide-y">
        {staff.map((s) => (
          <StaffRow key={s._id} member={s} roles={roles} />
        ))}
      </ul>
    </section>
  )
}

export function StaffRoleBadge({ role, roles }: { role: string; roles?: StaffRoleInfo[] }) {
  return <Badge variant={role === "super_admin" ? "default" : "muted"}>{roleLabel(role, roles)}</Badge>
}

type Confirm = "disable" | "enable" | "sign-out"

function StaffRow({ member, roles }: { member: StaffMember; roles: StaffRoleInfo[] }) {
  const [dialog, setDialog] = useState<"role" | Confirm | null>(null)
  const disabled = member.status === "disabled"

  return (
    <li
      className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-3 px-6 py-4 sm:px-8 ${COLUMNS}`}
    >
      <div className="flex min-w-0 items-center gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-[12px] bg-brand-subtle font-display text-sm font-semibold text-primary">
          {initials(member.name)}
        </span>
        <div className="grid min-w-0">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate font-medium">{member.name}</span>
            {member.isYou && <Badge variant="outline">You</Badge>}
          </span>
          <span className="truncate text-sm text-muted-foreground">{member.email}</span>
        </div>
      </div>

      {/* Mobile: actions sit top right; the details wrap underneath. Nobody manages their own access. */}
      <div className="justify-self-end md:order-last">
        {!member.isYou && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={`Manage ${member.name}`}>
                <MoreHorizontal aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem onSelect={() => setDialog("role")}>
                <UserCog aria-hidden />
                Change role
              </DropdownMenuItem>
              {!disabled && (
                <DropdownMenuItem onSelect={() => setDialog("sign-out")}>
                  <LogOut aria-hidden />
                  Sign out everywhere
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              {disabled ? (
                <DropdownMenuItem onSelect={() => setDialog("enable")}>
                  <UserCheck aria-hidden />
                  Turn account back on
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem variant="destructive" onSelect={() => setDialog("disable")}>
                  <UserX aria-hidden />
                  Turn account off
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      <div className="col-span-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm md:contents">
        <span>
          <StaffRoleBadge role={member.role} roles={roles} />
        </span>
        <span>{disabled ? <Badge variant="warning">Off</Badge> : <Badge variant="success">Active</Badge>}</span>
        <span className="text-muted-foreground">
          <span className="md:hidden">Last signed in </span>
          {member.lastSignInAt ? timeAgo(member.lastSignInAt) : "Never"}
        </span>
      </div>

      {dialog === "role" && <RoleDialog member={member} roles={roles} onClose={() => setDialog(null)} />}
      {dialog && dialog !== "role" && (
        <ConfirmDialog kind={dialog} member={member} onClose={() => setDialog(null)} />
      )}
    </li>
  )
}

/** Mounted only while open, so the form starts from the member's current role. */
function RoleDialog({ member, roles, onClose }: { member: StaffMember; roles: StaffRoleInfo[]; onClose: () => void }) {
  const form = useForm<StaffRoleValues>({
    resolver: zodResolver(staffRoleSchema),
    defaultValues: { role: member.role },
  })
  const { isSubmitting, isDirty, errors } = form.formState

  async function onSubmit(values: StaffRoleValues) {
    const result = await changeStaffRole(member._id, values)
    if (!applyResult(form, result)) return
    onClose()
    toast.success(`${member.name} is now ${roleLabel(result.data.role, roles)}.`)
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Change {member.name}&apos;s role</DialogTitle>
          <DialogDescription>The change applies straight away, the next time they load a page.</DialogDescription>
        </DialogHeader>
        <form id="role-form" onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid gap-6">
          <FormError message={errors.root?.message} />
          <RoleFields control={form.control} roles={roles} idPrefix={`role-${member._id}`} />
        </form>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={isSubmitting}>
              Cancel
            </Button>
          </DialogClose>
          <Button type="submit" form="role-form" disabled={isSubmitting || !isDirty}>
            {isSubmitting && <Spinner />}
            Save role
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const CONFIRM = {
  disable: {
    title: (name: string) => `Turn off ${name}'s account?`,
    body: "They're signed out everywhere and can't sign in until a super admin turns the account back on.",
    action: "Turn off",
    done: (name: string) => `${name}'s account is off.`,
    run: disableStaff,
    destructive: true,
  },
  enable: {
    title: (name: string) => `Turn ${name}'s account back on?`,
    body: "They can sign in again with their existing password and two-step method.",
    action: "Turn on",
    done: (name: string) => `${name} can sign in again.`,
    run: enableStaff,
    destructive: false,
  },
  "sign-out": {
    title: (name: string) => `Sign ${name} out everywhere?`,
    body: "Every session they have open ends now. They can sign in again straight away.",
    action: "Sign out",
    done: (name: string) => `${name} has been signed out everywhere.`,
    run: signOutStaff,
    destructive: false,
  },
} satisfies Record<Confirm, unknown>

function ConfirmDialog({ kind, member, onClose }: { kind: Confirm; member: StaffMember; onClose: () => void }) {
  const [pending, startTransition] = useTransition()
  const copy = CONFIRM[kind]

  function confirm() {
    startTransition(async () => {
      const result = await copy.run(member._id)
      if (result.ok) {
        onClose()
        toast.success(copy.done(member.name))
      } else toast.error(result.error)
    })
  }

  return (
    <AlertDialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{copy.title(member.name)}</AlertDialogTitle>
          <AlertDialogDescription>{copy.body}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant={copy.destructive ? "destructive" : "default"}
            disabled={pending}
            onClick={(e) => {
              e.preventDefault()
              confirm()
            }}
          >
            {pending && <Spinner />}
            {copy.action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
