"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Check, MessageSquareWarning, X } from "lucide-react"
import { toast } from "sonner"
import { approveBusiness, rejectBusiness, requestChanges } from "@/app/admin/actions"
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
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
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
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import type { ActionResult } from "@/lib/action-result"

type Doc = { _id: string; label: string }
type Props = { businessId: string; businessName: string; documents: Doc[] }

export function ReviewActions({ businessId, businessName, documents }: Props) {
  return (
    <div className="flex flex-wrap gap-2">
      <RejectDialog businessId={businessId} businessName={businessName} />
      <RequestChangesDialog businessId={businessId} documents={documents} />
      <ApproveDialog businessId={businessId} businessName={businessName} />
    </div>
  )
}

function useReview() {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string>()
  function run(fn: () => Promise<ActionResult<unknown>>, success: string, onDone: () => void) {
    setError(undefined)
    startTransition(async () => {
      const result = await fn()
      if (result.ok) {
        toast.success(success)
        onDone()
        router.refresh()
      } else setError(result.error)
    })
  }
  return { pending, error, setError, run }
}

function ApproveDialog({ businessId, businessName }: { businessId: string; businessName: string }) {
  const [open, setOpen] = useState(false)
  const { pending, error, run } = useReview()
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button>
          <Check data-icon="inline-start" aria-hidden />
          Approve
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Approve {businessName}?</AlertDialogTitle>
          <AlertDialogDescription>
            All documents are marked accepted and the owner gets full access to their dashboard. They&apos;ll be emailed
            straight away.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <FormError message={error} />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={pending}
            onClick={(e) => {
              e.preventDefault()
              run(() => approveBusiness(businessId), `${businessName} approved.`, () => setOpen(false))
            }}
          >
            {pending && <Spinner />}
            Approve business
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function RequestChangesDialog({ businessId, documents }: { businessId: string; documents: Doc[] }) {
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState("")
  const [selected, setSelected] = useState<Record<string, string>>({})
  const [touched, setTouched] = useState(false)
  const { pending, error, setError, run } = useReview()

  const chosen = Object.entries(selected)
  const noteError = touched && !note.trim() ? "Tell the owner what to change." : undefined
  const reasonMissing = (id: string) => touched && !selected[id]?.trim()

  function reset(next: boolean) {
    setOpen(next)
    if (!next) {
      setNote("")
      setSelected({})
      setTouched(false)
      setError(undefined)
    }
  }

  function submit(e: React.FormEvent) {
    e.preventDefault()
    setTouched(true)
    if (!note.trim() || chosen.some(([, reason]) => !reason.trim())) return
    run(
      () =>
        requestChanges(businessId, {
          note,
          documents: chosen.map(([id, reason]) => ({ id, reason })),
        }),
      "Sent back to the owner with your notes.",
      () => reset(false),
    )
  }

  return (
    <Dialog open={open} onOpenChange={reset}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <MessageSquareWarning data-icon="inline-start" aria-hidden />
          Request changes
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Request changes</DialogTitle>
          <DialogDescription>
            The owner sees your note and each document reason, and can edit and resubmit.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} noValidate className="grid gap-6">
          <FormError message={error} />
          <Field data-invalid={!!noteError}>
            <FieldLabel htmlFor="note">Note to the owner</FieldLabel>
            <Textarea
              id="note"
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              aria-invalid={!!noteError}
            />
            {noteError ? <FieldError>{noteError}</FieldError> : <FieldDescription>Be specific. This is emailed to them.</FieldDescription>}
          </Field>

          {documents.length > 0 && (
            <fieldset className="grid gap-3">
              <legend className="mb-2 text-sm font-medium">Documents to replace</legend>
              {documents.map((d) => {
                const checked = d._id in selected
                return (
                  <div key={d._id} className="grid gap-2 rounded-lg border p-3">
                    <Field orientation="horizontal">
                      <Checkbox
                        id={`doc-${d._id}`}
                        checked={checked}
                        onCheckedChange={(c) =>
                          setSelected((s) => {
                            const next = { ...s }
                            if (c) next[d._id] = ""
                            else delete next[d._id]
                            return next
                          })
                        }
                      />
                      <FieldLabel htmlFor={`doc-${d._id}`} className="font-normal">
                        {d.label}
                      </FieldLabel>
                    </Field>
                    {checked && (
                      <Field data-invalid={reasonMissing(d._id)}>
                        <FieldLabel htmlFor={`reason-${d._id}`} className="text-xs font-normal text-muted-foreground">
                          What needs fixing
                        </FieldLabel>
                        <Input
                          id={`reason-${d._id}`}
                          placeholder="e.g. Scan is blurry, the RC number isn't readable"
                          value={selected[d._id]}
                          onChange={(e) => setSelected((s) => ({ ...s, [d._id]: e.target.value }))}
                          aria-invalid={reasonMissing(d._id)}
                          autoFocus
                        />
                        {reasonMissing(d._id) && <FieldError>Say what&apos;s wrong with this document.</FieldError>}
                      </Field>
                    )}
                  </div>
                )
              })}
            </fieldset>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => reset(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending && <Spinner />}
              Send to owner
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function RejectDialog({ businessId, businessName }: { businessId: string; businessName: string }) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState("")
  const [touched, setTouched] = useState(false)
  const { pending, error, setError, run } = useReview()
  const reasonError = touched && !reason.trim() ? "Give a reason the owner will see." : undefined

  function reset(next: boolean) {
    setOpen(next)
    if (!next) {
      setReason("")
      setTouched(false)
      setError(undefined)
    }
  }

  return (
    <Dialog open={open} onOpenChange={reset}>
      <DialogTrigger asChild>
        <Button variant="outline" className="text-destructive">
          <X data-icon="inline-start" aria-hidden />
          Reject
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Reject {businessName}?</DialogTitle>
          <DialogDescription>
            This is final. The owner can&apos;t edit or resubmit, and they&apos;ll be emailed your reason.
          </DialogDescription>
        </DialogHeader>
        <form
          noValidate
          className="grid gap-6"
          onSubmit={(e) => {
            e.preventDefault()
            setTouched(true)
            if (!reason.trim()) return
            run(() => rejectBusiness(businessId, { reason }), `${businessName} rejected.`, () => reset(false))
          }}
        >
          <FormError message={error} />
          <Field data-invalid={!!reasonError}>
            <FieldLabel htmlFor="reason">Reason</FieldLabel>
            <Textarea id="reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} aria-invalid={!!reasonError} />
            {reasonError && <FieldError>{reasonError}</FieldError>}
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => reset(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={pending}>
              {pending && <Spinner />}
              Reject business
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
