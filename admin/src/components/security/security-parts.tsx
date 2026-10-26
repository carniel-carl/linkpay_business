"use client"

import { useState } from "react"
import { Check, PhoneCall, ShieldCheck, Snowflake, UserCheck, X } from "lucide-react"
import {
  approveSecurityRequest,
  clearUserHold,
  freezeBusinessMoneyOut,
  rejectSecurityRequest,
  unfreezeBusinessMoneyOut,
} from "@/app/(console)/security-reviews/actions"
import { useComplianceAction } from "@/components/compliance/dialogs"
import { FormError } from "@/components/common/form-error"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import type { ActionResult } from "@/lib/action-result"
import type { SecurityRequestStatus, SecurityRisk } from "@/lib/api/types"

// ---- Tags ----

const STATUS: Record<SecurityRequestStatus, { label: string; variant: "warning" | "secondary" | "success" | "destructive" | "muted" }> = {
  pending: { label: "Waiting for review", variant: "warning" },
  approved: { label: "Approved, cooling off", variant: "secondary" },
  completed: { label: "In effect", variant: "success" },
  rejected: { label: "Rejected", variant: "destructive" },
  cancelled: { label: "Cancelled", variant: "muted" },
}

export function RequestStatusBadge({ status }: { status: SecurityRequestStatus }) {
  return <Badge variant={STATUS[status].variant}>{STATUS[status].label}</Badge>
}

const RISK: Record<SecurityRisk, { label: string; variant: "destructive" | "warning" | "muted" }> = {
  high: { label: "High risk", variant: "destructive" },
  medium: { label: "Medium risk", variant: "warning" },
  low: { label: "Low risk", variant: "muted" },
}

/** Risk as a status tag: icon plus label, never colour alone. */
export function RiskBadge({ risk }: { risk?: SecurityRisk }) {
  if (!risk) return null
  return (
    <Badge variant={RISK[risk].variant}>
      <ShieldCheck data-icon="inline-start" aria-hidden />
      {RISK[risk].label}
    </Badge>
  )
}

// ---- One dialog with a note, used by every action here ----

function NoteDialog({
  trigger,
  title,
  description,
  noteLabel,
  noteHelp,
  confirm,
  destructive,
  callback,
  done,
  submit,
}: {
  trigger: React.ReactNode
  title: string
  description: React.ReactNode
  noteLabel: string
  noteHelp?: string
  confirm: string
  destructive?: boolean
  /** Ask the reviewer to confirm they called the business back (approving). */
  callback?: React.ReactNode
  done: string
  submit: (note: string, callbackConfirmed: boolean) => Promise<ActionResult<unknown>>
}) {
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState("")
  const [called, setCalled] = useState(false)
  const [touched, setTouched] = useState(false)
  const { pending, error, setError, run } = useComplianceAction()
  const noteError = touched && note.trim().length < 3 ? "Write a short note (at least 3 characters)." : undefined
  const callError = touched && callback && !called ? "Call the business back before approving." : undefined

  function reset(next: boolean) {
    setOpen(next)
    if (!next) {
      setNote("")
      setCalled(false)
      setTouched(false)
      setError(undefined)
    }
  }

  return (
    <Dialog open={open} onOpenChange={reset}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form
          noValidate
          className="grid gap-6"
          onSubmit={(e) => {
            e.preventDefault()
            setTouched(true)
            if (note.trim().length < 3 || (callback && !called)) return
            run(() => submit(note.trim(), called), done, () => reset(false))
          }}
        >
          <FormError message={error} />
          {callback && (
            <Field orientation="horizontal" data-invalid={!!callError}>
              <Checkbox id="callback" checked={called} onCheckedChange={(v) => setCalled(v === true)} aria-invalid={!!callError} />
              <div className="grid gap-1">
                <FieldLabel htmlFor="callback">I called the business back and it confirmed this</FieldLabel>
                <FieldDescription>{callback}</FieldDescription>
                {callError && <FieldError>{callError}</FieldError>}
              </div>
            </Field>
          )}
          <Field data-invalid={!!noteError}>
            <FieldLabel htmlFor="security-note">{noteLabel}</FieldLabel>
            <Textarea id="security-note" rows={4} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} aria-invalid={!!noteError} />
            {noteHelp && <FieldDescription>{noteHelp}</FieldDescription>}
            {noteError && <FieldError>{noteError}</FieldError>}
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => reset(false)}>
              Cancel
            </Button>
            <Button type="submit" variant={destructive ? "destructive" : "default"} disabled={pending}>
              {pending && <Spinner />}
              {confirm}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ---- Review decisions ----

export function ReviewActions({ requestId, what, availableAt }: { requestId: string; what: string; availableAt: string }) {
  return (
    <div className="flex flex-wrap gap-2">
      <NoteDialog
        trigger={
          <Button variant="outline">
            <X data-icon="inline-start" aria-hidden />
            Reject
          </Button>
        }
        title="Reject this change?"
        description={`The business is told ${what} wasn't approved, with your note as the reason.`}
        noteLabel="Reason (shown to the business)"
        confirm="Reject"
        destructive
        done="Rejected. The business has been told."
        submit={(note) => rejectSecurityRequest(requestId, { note })}
      />
      <NoteDialog
        trigger={
          <Button>
            <Check data-icon="inline-start" aria-hidden />
            Approve
          </Button>
        }
        title="Approve this change?"
        description={`It takes effect at the end of the cooling-off (${new Date(availableAt).toLocaleString("en-NG", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Lagos" })}), not before.`}
        callback={
          <>
            <PhoneCall className="mr-1 inline size-3.5" aria-hidden />
            Use a number from the business&apos;s verification (listed on this page), never one the requester gives you.
          </>
        }
        noteLabel="Note (staff only)"
        noteHelp="Who you spoke to and what they confirmed."
        confirm="Approve"
        done="Approved. It takes effect when the cooling-off ends."
        submit={(note, callbackConfirmed) => approveSecurityRequest(requestId, { note, callbackConfirmed })}
      />
    </div>
  )
}

// ---- Freezing, and clearing a person's hold ----

export function FreezeButtons({ businessId, frozen }: { businessId: string; frozen: boolean }) {
  return frozen ? (
    <NoteDialog
      trigger={
        <Button variant="outline">
          <ShieldCheck data-icon="inline-start" aria-hidden />
          Unfreeze money out
        </Button>
      }
      title="Unfreeze money out?"
      description="Transfers, approvals and withdrawals can go out again, including transfers that were held. Only do this after speaking to the business."
      noteLabel="Note (staff only)"
      noteHelp="Who you spoke to and why it's safe."
      confirm="Unfreeze"
      done="Unfrozen. The business has been told."
      submit={(note) => unfreezeBusinessMoneyOut(businessId, { note })}
    />
  ) : (
    <NoteDialog
      trigger={
        <Button variant="destructive">
          <Snowflake data-icon="inline-start" aria-hidden />
          Freeze money out
        </Button>
      }
      title="Freeze money out?"
      description="Nothing can be sent, approved or withdrawn, and open settlement changes are cancelled. Money still comes in. Only staff can lift a freeze you make."
      noteLabel="Reason (shown to the business's team)"
      confirm="Freeze"
      destructive
      done="Frozen. The business has been told."
      submit={(reason) => freezeBusinessMoneyOut(businessId, { reason })}
    />
  )
}

export function ClearHoldButton({ userId, name }: { userId: string; name: string }) {
  return (
    <NoteDialog
      trigger={
        <Button variant="outline" size="sm">
          <UserCheck data-icon="inline-start" aria-hidden />
          Clear {name}&apos;s hold
        </Button>
      }
      title={`Clear ${name}'s hold?`}
      description="They'll be able to send, approve and withdraw money again (their own holds only; a business freeze stays). Only after you've checked it's really them."
      noteLabel="Note (staff only)"
      confirm="Clear hold"
      done="Hold cleared."
      submit={(note) => clearUserHold(userId, { note })}
    />
  )
}
