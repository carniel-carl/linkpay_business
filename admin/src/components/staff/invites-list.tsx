"use client"

import { useEffect, useState, useTransition } from "react"
import { MailPlus, RotateCw, X } from "lucide-react"
import { toast } from "sonner"
import { resendStaffInvite, revokeStaffInvite } from "@/app/(console)/staff/actions"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import type { StaffInvite, StaffRoleInfo } from "@/lib/api/types"
import { formatDate, timeAgo } from "@/lib/format"
import { StaffRoleBadge } from "./staff-list"

const COOLDOWN_MS = 60_000 // the backend allows one resend a minute (and says when, on INVITE_COOLDOWN)

export function StaffInvitesList({ invites, roles }: { invites: StaffInvite[]; roles: StaffRoleInfo[] }) {
  return (
    <section aria-labelledby="invites-title" className="surface overflow-hidden">
      <div className="flex items-baseline justify-between gap-4 border-b px-6 py-5 sm:px-8">
        <h2 id="invites-title" className="font-display text-lg font-semibold tracking-[-0.02em]">
          Pending invites
        </h2>
        <span className="text-sm text-muted-foreground figure">{invites.length}</span>
      </div>
      {invites.length === 0 ? (
        <div className="flex items-center gap-3 px-6 py-6 text-sm text-muted-foreground sm:px-8">
          <MailPlus className="size-4 shrink-0" aria-hidden />
          No invites waiting. People you invite show here until they set up their sign-in.
        </div>
      ) : (
        <ul className="divide-y">
          {invites.map((invite) => (
            <InviteRow key={invite._id} invite={invite} roles={roles} />
          ))}
        </ul>
      )}
    </section>
  )
}

function InviteRow({ invite, roles }: { invite: StaffInvite; roles: StaffRoleInfo[] }) {
  const [resending, startResend] = useTransition()
  // How long Resend stays disabled: the backend's retryAt when it gives one, otherwise a minute.
  const [cooldownMs, setCooldownMs] = useState(0)
  const coolingDown = cooldownMs > 0

  useEffect(() => {
    if (!cooldownMs) return
    const id = setTimeout(() => setCooldownMs(0), cooldownMs)
    return () => clearTimeout(id)
  }, [cooldownMs])

  function resend() {
    startResend(async () => {
      const result = await resendStaffInvite(invite._id)
      if (result.ok) {
        setCooldownMs(COOLDOWN_MS)
        toast.success(`New link sent to ${invite.email}. The old one no longer works.`)
      } else if (result.code === "INVITE_COOLDOWN") {
        const wait = result.retryAt ? Math.max(1000, new Date(result.retryAt).getTime() - Date.now()) : COOLDOWN_MS
        setCooldownMs(wait)
        const seconds = Math.ceil(wait / 1000)
        toast.info(`This invite was sent moments ago. You can resend it in ${seconds} ${seconds === 1 ? "second" : "seconds"}.`)
      } else toast.error(result.error)
    })
  }

  return (
    <li className="grid gap-3 px-6 py-4 sm:px-8 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
      <div className="grid min-w-0 gap-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate font-medium">{invite.email}</span>
          <StaffRoleBadge role={invite.role} roles={roles} />
        </div>
        <p className="text-sm text-muted-foreground">
          Sent {timeAgo(invite.lastSentAt)}
          {invite.invitedBy && ` by ${invite.invitedBy.name}`}
          {" · "}
          Expires {formatDate(invite.expiresAt)}
        </p>
      </div>
      <div className="-ml-3 flex items-center gap-1 md:ml-0">
        <Button variant="ghost" size="sm" onClick={resend} disabled={resending || coolingDown}>
          {resending ? <Spinner /> : <RotateCw data-icon="inline-start" aria-hidden />}
          {coolingDown ? "Sent" : "Resend"}
        </Button>
        <RevokeButton invite={invite} />
      </div>
    </li>
  )
}

function RevokeButton({ invite }: { invite: StaffInvite }) {
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()

  function revoke() {
    startTransition(async () => {
      const result = await revokeStaffInvite(invite._id)
      if (result.ok) {
        setOpen(false)
        toast.success(`Invite for ${invite.email} cancelled.`)
      } else toast.error(result.error)
    })
  }

  return (
    <AlertDialog open={open} onOpenChange={(next) => !pending && setOpen(next)}>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive">
          <X data-icon="inline-start" aria-hidden />
          Revoke
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Revoke this invite?</AlertDialogTitle>
          <AlertDialogDescription>
            The link sent to {invite.email} stops working. You can invite them again later.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Keep invite</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={pending}
            onClick={(e) => {
              e.preventDefault()
              revoke()
            }}
          >
            {pending && <Spinner />}
            Revoke invite
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
