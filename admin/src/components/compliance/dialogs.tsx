"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Ban, CirclePause, CirclePlay, Flag, MessageSquarePlus, RotateCcw } from "lucide-react"
import { toast } from "sonner"
import { addNote, changeRestriction, raiseFlag } from "@/app/(console)/compliance/actions"
import { FormError } from "@/components/common/form-error"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Field, FieldContent, FieldDescription, FieldError, FieldLabel, FieldLegend, FieldSet, FieldTitle } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { NativeSelect } from "@/components/ui/native-select"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import type { ActionResult } from "@/lib/action-result"
import type { ComplianceRules, FlagCategory, FlagSeverity } from "@/lib/api/types"
import { SEVERITIES, SEVERITY_LABELS } from "@/lib/compliance"

type Categories = ComplianceRules["categories"]

/** Runs a compliance action: toast and refresh on success, the error inline otherwise. */
export function useComplianceAction() {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string>()
  function run<T>(fn: () => Promise<ActionResult<T>>, success: string, onDone: (data: T) => void) {
    setError(undefined)
    startTransition(async () => {
      const result = await fn()
      if (result.ok) {
        toast.success(success)
        onDone(result.data)
        router.refresh()
      } else setError(result.error)
    })
  }
  return { pending, error, setError, run }
}

// ---- Raise a flag ----

const SEVERITY_HELP: Record<FlagSeverity, string> = {
  high: "Likely fraud or money laundering. Look at it today.",
  medium: "Unusual and worth a closer look.",
  low: "Worth keeping an eye on.",
}

/**
 * Flags a business for staff to look into. The business never sees flags. `evidence` attaches payments or
 * transfers ticked in the Activity tab; pass `open` and `onOpenChange` to control it from there.
 */
export function RaiseFlagDialog({
  businessId,
  businessName,
  categories,
  evidence,
  open: controlledOpen,
  onOpenChange,
  onDone,
  trigger = true,
}: {
  businessId: string
  businessName: string
  categories: Categories
  evidence?: { transactionIds?: string[]; transferIds?: string[] }
  open?: boolean
  onOpenChange?: (open: boolean) => void
  onDone?: () => void
  /** Show the "Flag this business" button. */
  trigger?: boolean
}) {
  const [ownOpen, setOwnOpen] = useState(false)
  const open = controlledOpen ?? ownOpen
  const [category, setCategory] = useState<FlagCategory | "">("")
  const [severity, setSeverity] = useState<FlagSeverity>("medium")
  const [summary, setSummary] = useState("")
  const [note, setNote] = useState("")
  const [touched, setTouched] = useState(false)
  const { pending, error, setError, run } = useComplianceAction()

  const evidenceCount = (evidence?.transactionIds?.length ?? 0) + (evidence?.transferIds?.length ?? 0)
  const categoryError = touched && !category ? "Choose what the concern is about." : undefined
  const summaryError = touched && summary.trim().length < 3 ? "Write one line staff will read in the queue." : undefined

  function setOpen(next: boolean) {
    setOwnOpen(next)
    onOpenChange?.(next)
    if (!next) {
      setCategory("")
      setSeverity("medium")
      setSummary("")
      setNote("")
      setTouched(false)
      setError(undefined)
    }
  }

  function submit(e: React.FormEvent) {
    e.preventDefault()
    setTouched(true)
    if (!category || summary.trim().length < 3) return
    run(
      () => raiseFlag(businessId, { category, severity, summary, note, ...evidence }),
      `${businessName} flagged.`,
      () => {
        setOpen(false)
        onDone?.()
      },
    )
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger && (
        <DialogTrigger asChild>
          <Button variant="outline">
            <Flag data-icon="inline-start" aria-hidden />
            Flag this business
          </Button>
        </DialogTrigger>
      )}
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Flag {businessName}</DialogTitle>
          <DialogDescription>
            Raises a concern for compliance staff to look into. The business isn&apos;t told, and nothing about its
            account changes.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} noValidate className="grid gap-6">
          <FormError message={error} />
          {evidenceCount > 0 && (
            <p className="rounded-lg bg-brand-subtle px-3 py-2 text-sm">
              <span className="figure">{evidenceCount}</span> {evidenceCount === 1 ? "item" : "items"} from Activity will be
              attached as evidence.
            </p>
          )}
          <Field data-invalid={!!categoryError}>
            <FieldLabel htmlFor="flag-category">Concern</FieldLabel>
            <NativeSelect
              id="flag-category"
              value={category}
              onChange={(e) => setCategory(e.target.value as FlagCategory)}
              aria-invalid={!!categoryError}
            >
              <option value="">Choose one</option>
              {categories.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </NativeSelect>
            {categoryError && <FieldError>{categoryError}</FieldError>}
          </Field>

          <FieldSet>
            <FieldLegend variant="label">Severity</FieldLegend>
            <RadioGroup value={severity} onValueChange={(v) => setSeverity(v as FlagSeverity)}>
              {SEVERITIES.map((s) => (
                <FieldLabel key={s} htmlFor={`flag-severity-${s}`}>
                  <Field orientation="horizontal">
                    <FieldContent>
                      <FieldTitle>{SEVERITY_LABELS[s]}</FieldTitle>
                      <FieldDescription className="text-xs">{SEVERITY_HELP[s]}</FieldDescription>
                    </FieldContent>
                    <RadioGroupItem value={s} id={`flag-severity-${s}`} />
                  </Field>
                </FieldLabel>
              ))}
            </RadioGroup>
          </FieldSet>

          <Field data-invalid={!!summaryError}>
            <FieldLabel htmlFor="flag-summary">Summary</FieldLabel>
            <Input
              id="flag-summary"
              maxLength={200}
              placeholder="e.g. Payer reported a transfer as fraud"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              aria-invalid={!!summaryError}
            />
            {summaryError ? <FieldError>{summaryError}</FieldError> : <FieldDescription>One line, shown in the flags queue.</FieldDescription>}
          </Field>

          <Field>
            <FieldLabel htmlFor="flag-note">Note (optional)</FieldLabel>
            <Textarea id="flag-note" rows={3} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
            <FieldDescription>What you found and where. Staff only.</FieldDescription>
          </Field>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending && <Spinner />}
              Raise flag
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ---- Add a note ----

/** A staff-only note on the business's timeline. Notes can't be edited or deleted. */
export function AddNoteDialog({ businessId }: { businessId: string }) {
  const [open, setOpen] = useState(false)
  const [body, setBody] = useState("")
  const [touched, setTouched] = useState(false)
  const { pending, error, setError, run } = useComplianceAction()
  const bodyError = touched && !body.trim() ? "Write the note." : undefined

  function reset(next: boolean) {
    setOpen(next)
    if (!next) {
      setBody("")
      setTouched(false)
      setError(undefined)
    }
  }

  return (
    <Dialog open={open} onOpenChange={reset}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <MessageSquarePlus data-icon="inline-start" aria-hidden />
          Add note
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a note</DialogTitle>
          <DialogDescription>Goes on this business&apos;s timeline for staff. It can&apos;t be edited or removed later.</DialogDescription>
        </DialogHeader>
        <form
          noValidate
          className="grid gap-6"
          onSubmit={(e) => {
            e.preventDefault()
            setTouched(true)
            if (!body.trim()) return
            run(() => addNote(businessId, { body }), "Note added.", () => reset(false))
          }}
        >
          <FormError message={error} />
          <Field data-invalid={!!bodyError}>
            <FieldLabel htmlFor="note-body">Note</FieldLabel>
            <Textarea id="note-body" rows={4} maxLength={2000} value={body} onChange={(e) => setBody(e.target.value)} aria-invalid={!!bodyError} />
            {bodyError && <FieldError>{bodyError}</FieldError>}
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => reset(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending && <Spinner />}
              Add note
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ---- Suspend, reinstate, close, lift ban ----

type RestrictionAction = "suspend" | "reinstate" | "ban" | "unban"

const RESTRICTION_COPY: Record<
  RestrictionAction,
  { button: string; title: (name: string) => string; confirm: string; done: (name: string) => string; effects: string[]; destructive?: boolean }
> = {
  suspend: {
    button: "Suspend",
    title: (n) => `Suspend ${n}?`,
    confirm: "Suspend business",
    done: (n) => `${n} is suspended.`,
    effects: [
      "The team can still sign in and look, but can't send money or change anything.",
      "Approved transfers not yet sent are held until you reinstate it.",
      "Public invoice links stop working and reminders stop.",
      "Payments into its accounts still land.",
      "The owner is emailed that the business is suspended, without your reason or note.",
    ],
  },
  reinstate: {
    button: "Reinstate",
    title: (n) => `Reinstate ${n}?`,
    confirm: "Reinstate business",
    done: (n) => `${n} is active again.`,
    effects: [
      "The team can use everything again.",
      "Held transfers are sent.",
      "Invoice links and reminders start again.",
      "The owner is emailed that the business is active again.",
    ],
  },
  ban: {
    button: "Close business",
    title: (n) => `Close ${n}?`,
    confirm: "Close business",
    done: (n) => `${n} is closed.`,
    destructive: true,
    effects: [
      "Every member is locked out of the business. They see a closed notice instead.",
      "Transfers waiting for approval are cancelled and open team invites are revoked.",
      "Other LinkPay businesses can't send money to its accounts.",
      "It can't be resubmitted or approved while closed.",
      "Money left in its accounts stays there. Settling it is a manual process for now.",
      "The owner is emailed that the business is closed, without your reason or note.",
    ],
  },
  unban: {
    button: "Lift ban",
    title: (n) => `Lift the ban on ${n}?`,
    confirm: "Lift ban",
    done: (n) => `${n} is active again.`,
    effects: [
      "The business becomes active, and its team can sign in and use it again.",
      "Cancelled transfers and revoked invites stay cancelled.",
      "The owner is emailed that the business is active again.",
    ],
  },
}

const RESTRICTION_ICON = { suspend: CirclePause, reinstate: CirclePlay, ban: Ban, unban: RotateCcw }

/**
 * Confirms a change to what the business can do. Suspending and closing need a reason and a note; lifting
 * either needs a note. The dialog spells out what happens to the business before anything changes.
 */
export function RestrictionDialog({
  action,
  businessId,
  businessName,
  categories,
  defaultReason,
}: {
  action: RestrictionAction
  businessId: string
  businessName: string
  categories: Categories
  /** Pre-selects the reason, e.g. the current suspension's reason when closing. */
  defaultReason?: FlagCategory | null
}) {
  const copy = RESTRICTION_COPY[action]
  const Icon = RESTRICTION_ICON[action]
  const needsReason = action === "suspend" || action === "ban"
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState<FlagCategory | "">(defaultReason ?? "")
  const [note, setNote] = useState("")
  const [touched, setTouched] = useState(false)
  const { pending, error, setError, run } = useComplianceAction()
  const reasonError = needsReason && touched && !reason ? "Choose a reason." : undefined
  const noteError = touched && !note.trim() ? "Explain why for other staff. The business never sees this." : undefined

  function reset(next: boolean) {
    setOpen(next)
    if (!next) {
      setReason(defaultReason ?? "")
      setNote("")
      setTouched(false)
      setError(undefined)
    }
  }

  return (
    <Dialog open={open} onOpenChange={reset}>
      <DialogTrigger asChild>
        <Button variant={copy.destructive ? "destructive" : "outline"} className={action === "suspend" ? "text-destructive" : undefined}>
          <Icon data-icon="inline-start" aria-hidden />
          {copy.button}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{copy.title(businessName)}</DialogTitle>
          <DialogDescription>What happens:</DialogDescription>
        </DialogHeader>
        <ul className="-mt-2 grid list-disc gap-1.5 pl-5 text-sm text-pretty">
          {copy.effects.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
        <form
          noValidate
          className="grid gap-6"
          onSubmit={(e) => {
            e.preventDefault()
            setTouched(true)
            if ((needsReason && !reason) || !note.trim()) return
            run(
              () => changeRestriction(businessId, action, needsReason ? { reason, note } : { note }),
              copy.done(businessName),
              () => reset(false),
            )
          }}
        >
          <FormError message={error} />
          {needsReason && (
            <Field data-invalid={!!reasonError}>
              <FieldLabel htmlFor={`${action}-reason`}>Reason</FieldLabel>
              <NativeSelect
                id={`${action}-reason`}
                value={reason}
                onChange={(e) => setReason(e.target.value as FlagCategory)}
                aria-invalid={!!reasonError}
              >
                <option value="">Choose one</option>
                {categories.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </NativeSelect>
              {reasonError && <FieldError>{reasonError}</FieldError>}
            </Field>
          )}
          <Field data-invalid={!!noteError}>
            <FieldLabel htmlFor={`${action}-note`}>Note for staff</FieldLabel>
            <Textarea
              id={`${action}-note`}
              rows={3}
              maxLength={2000}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              aria-invalid={!!noteError}
            />
            {noteError ? (
              <FieldError>{noteError}</FieldError>
            ) : (
              <FieldDescription>Saved on the timeline. The business never sees it.</FieldDescription>
            )}
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => reset(false)}>
              Cancel
            </Button>
            <Button type="submit" variant={copy.destructive || action === "suspend" ? "destructive" : "default"} disabled={pending}>
              {pending && <Spinner />}
              {copy.confirm}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
