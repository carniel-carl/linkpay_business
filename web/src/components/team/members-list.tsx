"use client"

import { useState, useTransition } from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { MoreHorizontal, Store, UserCog, UserMinus } from "lucide-react"
import { useForm } from "react-hook-form"
import { toast } from "sonner"
import { removeMember, updateMemberAccess } from "@/app/(dashboard)/team/actions"
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
import { useTransactionPin } from "@/components/transaction-pin/use-transaction-pin"
import type { BranchRef, Membership, RoleInfo, RolesResponse, TeamMember } from "@/lib/api/types"
import { applyResult } from "@/lib/forms"
import { formatDate, initials } from "@/lib/format"
import { canManage, grantableRoles, isOwner, roleLabel } from "@/lib/permissions"
import { accessSchema, type AccessValues } from "@/lib/schemas"
import { AccessFields } from "./access-fields"

type Shared = {
  actor: Membership
  roles: RolesResponse
  branches: BranchRef[]
  businessName: string
}

/** Members in a list that reads as a table from md up and as cards below. */
export function MembersList({ members, ...shared }: Shared & { members: TeamMember[] }) {
  return (
    <section aria-labelledby="members-title" className="surface overflow-hidden">
      <div className="flex items-baseline justify-between gap-4 border-b px-6 py-5 sm:px-8">
        <h2 id="members-title" className="font-display text-lg font-semibold tracking-[-0.02em]">
          Members
        </h2>
        <span className="text-sm text-muted-foreground figure">
          {members.length} {members.length === 1 ? "person" : "people"}
        </span>
      </div>
      <div
        aria-hidden
        className="hidden grid-cols-[minmax(0,2.2fr)_7rem_minmax(0,1.4fr)_7rem_2.5rem] gap-4 bg-muted/60 px-8 py-2.5 text-xs font-medium text-muted-foreground md:grid"
      >
        <span>Member</span>
        <span>Role</span>
        <span>Branches</span>
        <span>Joined</span>
        <span />
      </div>
      <ul className="divide-y">
        {members.map((m) => (
          <MemberRow key={m._id} member={m} {...shared} />
        ))}
      </ul>
    </section>
  )
}

export function RoleBadge({ role, roles }: { role: string; roles?: RoleInfo[] }) {
  return <Badge variant={role === "owner" ? "default" : "muted"}>{roleLabel(role, roles)}</Badge>
}

export const branchSummary = (branches: BranchRef[]) =>
  branches.length === 0 ? "All branches" : branches.map((b) => b.name).join(", ")

function MemberRow({ member, actor, roles, branches, businessName }: Shared & { member: TeamMember }) {
  const [dialog, setDialog] = useState<"role" | "branches" | "remove" | null>(null)
  const name = member.user?.name ?? "Former user"
  const manageable = canManage(actor, member)
  const info = roles.roles.find((r) => r.role === member.role)
  const branchLimited = !!info && !info.businessWide && branches.length > 1

  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-3 px-6 py-4 sm:px-8 md:grid-cols-[minmax(0,2.2fr)_7rem_minmax(0,1.4fr)_7rem_2.5rem]">
      <div className="flex min-w-0 items-center gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-[12px] bg-brand-subtle font-display text-sm font-semibold text-primary">
          {initials(name)}
        </span>
        <div className="grid min-w-0">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate font-medium">{name}</span>
            {member.isYou && <Badge variant="outline">You</Badge>}
          </span>
          <span className="truncate text-sm text-muted-foreground">{member.user?.email}</span>
        </div>
      </div>

      {/* Mobile: actions sit top right; the details wrap underneath. */}
      <div className="justify-self-end md:order-last">
        {manageable && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={`Manage ${name}`}>
                <MoreHorizontal aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem onSelect={() => setDialog("role")}>
                <UserCog aria-hidden />
                Change role
              </DropdownMenuItem>
              {branchLimited && (
                <DropdownMenuItem onSelect={() => setDialog("branches")}>
                  <Store aria-hidden />
                  Change branches
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => setDialog("remove")}>
                <UserMinus aria-hidden />
                Remove from team
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      <div className="col-span-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm md:contents">
        <span>
          <RoleBadge role={member.role} roles={roles.roles} />
        </span>
        <span className="min-w-0 text-muted-foreground md:truncate md:text-foreground" title={branchSummary(member.branches)}>
          {branchSummary(member.branches)}
        </span>
        <span className="text-muted-foreground">
          <span className="md:hidden">Joined </span>
          {formatDate(member.joinedAt)}
        </span>
      </div>

      {(dialog === "role" || dialog === "branches") && (
        <AccessDialog
          member={member}
          name={name}
          mode={dialog}
          actor={actor}
          roles={roles}
          branches={branches}
          onClose={() => setDialog(null)}
        />
      )}
      <RemoveDialog
        open={dialog === "remove"}
        onOpenChange={(open) => setDialog(open ? "remove" : null)}
        memberId={member._id}
        name={name}
        businessName={businessName}
      />
    </li>
  )
}

/** Change role (with branches when the new role can be limited), or branches alone. Mounted only while open. */
function AccessDialog({
  member,
  name,
  mode,
  actor,
  roles,
  branches,
  onClose,
}: {
  member: TeamMember
  name: string
  mode: "role" | "branches"
  actor: Membership
  roles: RolesResponse
  branches: BranchRef[]
  onClose: () => void
}) {
  const form = useForm<AccessValues>({
    resolver: zodResolver(accessSchema),
    defaultValues: {
      role: member.role,
      allBranches: member.branches.length === 0,
      branches: member.branches.map((b) => b._id),
    },
  })
  const { isSubmitting, isDirty, errors } = form.formState
  const grantable = grantableRoles(actor, roles.roles)
  const pin = useTransactionPin()

  async function onSubmit(values: AccessValues) {
    const roleChanged = values.role !== member.role
    const result = await pin.confirm({
      purpose: roleChanged ? `make ${name} ${roleLabel(values.role, roles.roles)}` : `change ${name}'s branches`,
      confirmLabel: "Save changes",
      run: (transactionPin) => updateMemberAccess(member._id, values, transactionPin),
    })
    if (!result || !applyResult(form, result)) return
    onClose()
    toast.success(mode === "role" ? `${name} is now ${roleLabel(result.data.role, roles.roles)}.` : `${name}'s branches updated.`)
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{mode === "role" ? `Change ${name}'s role` : `Change ${name}'s branches`}</DialogTitle>
          <DialogDescription>
            {mode === "role"
              ? "The change applies straight away, the next time they load a page."
              : "They'll only see these branches and their accounts."}
          </DialogDescription>
        </DialogHeader>
        <form id="access-form" onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid gap-6">
          <FormError message={errors.root?.message} />
          <AccessFields
            form={form}
            roles={grantable}
            catalog={roles.permissions}
            branches={branches}
            adminHidden={!isOwner(actor)}
            idPrefix={`access-${member._id}`}
            hideRole={mode === "branches"}
          />
        </form>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={isSubmitting}>
              Cancel
            </Button>
          </DialogClose>
          <Button type="submit" form="access-form" disabled={isSubmitting || !isDirty}>
            {isSubmitting && <Spinner />}
            Save changes
          </Button>
        </DialogFooter>
        {pin.dialog}
      </DialogContent>
    </Dialog>
  )
}

function RemoveDialog({
  open,
  onOpenChange,
  memberId,
  name,
  businessName,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  memberId: string
  name: string
  businessName: string
}) {
  const [pending, startTransition] = useTransition()
  const pin = useTransactionPin()

  function remove() {
    startTransition(async () => {
      const result = await pin.confirm({
        purpose: `remove ${name} from ${businessName}`,
        confirmLabel: `Remove ${name}`,
        run: (transactionPin) => removeMember(memberId, transactionPin),
      })
      if (!result) return
      if (result.ok) {
        onOpenChange(false)
        toast.success(`${name} no longer has access to ${businessName}.`)
      } else toast.error(result.error)
    })
  }

  return (
    <AlertDialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {name}?</AlertDialogTitle>
          <AlertDialogDescription>
            They lose access to {businessName} straight away. Their LinkPay sign-in stays, and you can invite them again
            later.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={pending}
            onClick={(e) => {
              e.preventDefault()
              remove()
            }}
          >
            {pending && <Spinner />}
            Remove
          </AlertDialogAction>
        </AlertDialogFooter>
        {pin.dialog}
      </AlertDialogContent>
    </AlertDialog>
  )
}
