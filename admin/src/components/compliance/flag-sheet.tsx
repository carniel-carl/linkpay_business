"use client"

import { useEffect, useState, useTransition } from "react"
import Link from "next/link"
import { ArrowUpRight, Bot, CircleCheck, UserRound } from "lucide-react"
import { getFlag, resolveFlag } from "@/app/(console)/compliance/actions"
import { PaymentsTable, TransfersTable } from "@/components/activity/money-tables"
import { FormError } from "@/components/common/form-error"
import { useUrlState } from "@/components/common/url-state"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import type { Flag, FlagDetail, FlagOutcome } from "@/lib/api/types"
import { OUTCOME_LABELS } from "@/lib/compliance"
import { formatDateTime, formatNaira, timeAgo } from "@/lib/format"
import { RestrictionBadge, SeverityBadge } from "./badges"
import { useComplianceAction } from "./dialogs"

type Loaded = { id: string; flag?: FlagDetail; error?: string }

/**
 * One flag, opened from `?flag=<id>` (rows in the queue, the business's flags list and the
 * `compliance.flag_raised` notification all link there). Shows the evidence and, while open, Resolve.
 */
export function FlagSheet({ canManage }: { canManage: boolean }) {
  const { searchParams, navigate } = useUrlState()
  const flagId = searchParams.get("flag")
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [, startLoading] = useTransition()

  useEffect(() => {
    if (!flagId) return
    startLoading(async () => {
      const result = await getFlag(flagId)
      setLoaded(result.ok ? { id: flagId, flag: result.data } : { id: flagId, error: result.error })
    })
  }, [flagId])

  const current = loaded?.id === flagId ? loaded : null
  const flag = current?.flag

  return (
    <Sheet open={!!flagId} onOpenChange={(open) => !open && navigate({ flag: undefined })}>
      <SheetContent className="w-full gap-0 overflow-y-auto p-0 data-[side=right]:sm:max-w-2xl">
        <SheetHeader className="gap-3 border-b p-5 pr-12 sm:p-6 sm:pr-14">
          {flag ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <SeverityBadge severity={flag.severity} />
                {flag.status === "resolved" ? (
                  <Badge variant="success">
                    <CircleCheck data-icon="inline-start" aria-hidden />
                    {flag.resolution?.outcome ? OUTCOME_LABELS[flag.resolution.outcome] : "Resolved"}
                  </Badge>
                ) : (
                  <Badge variant="outline">Open</Badge>
                )}
                <RestrictionBadge status={flag.business.compliance} />
              </div>
              <SheetTitle className="font-display text-xl leading-snug font-semibold tracking-[-0.02em] text-pretty">
                {flag.summary}
              </SheetTitle>
              <SheetDescription className="flex flex-wrap items-center gap-x-1.5">
                <Link
                  href={`/businesses/${flag.business._id}/compliance`}
                  className="inline-flex items-center gap-0.5 font-medium text-foreground hover:underline"
                >
                  {flag.business.name ?? "Business"}
                  <ArrowUpRight className="size-3.5" aria-hidden />
                </Link>
                <span aria-hidden>·</span>
                <span>{flag.categoryLabel}</span>
              </SheetDescription>
            </>
          ) : (
            <>
              <SheetTitle className="sr-only">Flag</SheetTitle>
              <SheetDescription className="sr-only">Loading the flag</SheetDescription>
              {!current?.error && (
                <div className="grid gap-3" aria-busy aria-label="Loading">
                  <Skeleton className="h-6 w-40" />
                  <Skeleton className="h-7 w-4/5" />
                  <Skeleton className="h-4 w-56" />
                </div>
              )}
            </>
          )}
        </SheetHeader>

        {current?.error && (
          <div className="p-5 sm:p-6">
            <FormError message={current.error} />
          </div>
        )}
        {flag && <FlagBody flag={flag} canManage={canManage} onResolved={(f) => setLoaded({ id: f._id, flag: f })} />}
      </SheetContent>
    </Sheet>
  )
}

function FlagBody({ flag, canManage, onResolved }: { flag: FlagDetail; canManage: boolean; onResolved: (f: FlagDetail) => void }) {
  const metrics = Object.entries(flag.evidence.metrics).filter(([, v]) => v !== null && v !== undefined)
  const { transactions, transfers } = flag.evidence

  return (
    <div className="grid gap-6 p-5 sm:p-6">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 text-sm">
        <div className="grid gap-1">
          <dt className="text-xs text-muted-foreground">Raised by</dt>
          <dd className="flex items-center gap-1.5">
            {flag.source === "rule" ? (
              <>
                <Bot className="size-4 text-muted-foreground" aria-hidden />
                Automatic: {flag.ruleLabel}
              </>
            ) : (
              <>
                <UserRound className="size-4 text-muted-foreground" aria-hidden />
                {flag.raisedBy?.name ?? "A staff member"}
              </>
            )}
          </dd>
        </div>
        <div className="grid gap-1">
          <dt className="text-xs text-muted-foreground">Raised</dt>
          <dd className="figure">
            {formatDateTime(flag.createdAt)} <span className="text-muted-foreground">({timeAgo(flag.createdAt)})</span>
          </dd>
        </div>
        {metrics.map(([key, value]) => (
          <div key={key} className="grid gap-1">
            <dt className="text-xs text-muted-foreground">{METRIC_LABELS[key] ?? key}</dt>
            <dd className="figure">{formatMetric(key, value)}</dd>
          </div>
        ))}
      </dl>

      {flag.note && (
        <figure className="rounded-xl bg-muted/60 p-4">
          <figcaption className="text-xs font-medium text-muted-foreground">Note</figcaption>
          <blockquote className="mt-1.5 text-sm whitespace-pre-line">{flag.note}</blockquote>
        </figure>
      )}

      {transactions.length > 0 && (
        <section aria-labelledby="flag-payments" className="overflow-hidden rounded-xl border">
          <h3 id="flag-payments" className="border-b px-4 py-3 text-sm font-medium">
            Payments <span className="figure text-muted-foreground">({transactions.length})</span>
          </h3>
          <PaymentsTable items={transactions} caption="Payments behind this flag" filtered={false} />
        </section>
      )}
      {transfers.length > 0 && (
        <section aria-labelledby="flag-transfers" className="overflow-hidden rounded-xl border">
          <h3 id="flag-transfers" className="border-b px-4 py-3 text-sm font-medium">
            Transfers <span className="figure text-muted-foreground">({transfers.length})</span>
          </h3>
          <TransfersTable items={transfers} caption="Transfers behind this flag" filtered={false} />
        </section>
      )}

      {flag.status === "resolved" && flag.resolution ? (
        <figure className="surface border-l-4 border-l-success p-5">
          <figcaption className="text-xs font-medium text-muted-foreground">
            {flag.resolution.outcome ? OUTCOME_LABELS[flag.resolution.outcome] : "Resolved"}
            {flag.resolution.by && ` by ${flag.resolution.by.name}`}
            {flag.resolution.at && `, ${formatDateTime(flag.resolution.at)}`}
          </figcaption>
          {flag.resolution.note && <blockquote className="mt-2 text-sm whitespace-pre-line">{flag.resolution.note}</blockquote>}
        </figure>
      ) : canManage ? (
        <ResolveForm flagId={flag._id} onResolved={(f) => onResolved({ ...flag, ...f, evidence: flag.evidence })} />
      ) : (
        <p className="text-sm text-muted-foreground">Open. Your role can look at flags but not resolve them.</p>
      )}
    </div>
  )
}

const OUTCOME_HELP: Record<FlagOutcome, string> = {
  cleared: "You looked into it and found nothing wrong.",
  actioned: "Something was done about it, e.g. the business was suspended or asked for documents.",
}

function ResolveForm({ flagId, onResolved }: { flagId: string; onResolved: (flag: Flag) => void }) {
  const [outcome, setOutcome] = useState<FlagOutcome>("cleared")
  const [note, setNote] = useState("")
  const [touched, setTouched] = useState(false)
  const { pending, error, run } = useComplianceAction()
  const noteError = touched && !note.trim() ? "Say what you checked and what you found." : undefined

  return (
    <form
      noValidate
      className="grid gap-5 rounded-xl border p-5"
      onSubmit={(e) => {
        e.preventDefault()
        setTouched(true)
        if (!note.trim()) return
        run(() => resolveFlag(flagId, { outcome, note }), "Flag resolved.", onResolved)
      }}
    >
      <h3 className="font-display text-base font-semibold tracking-[-0.01em]">Resolve this flag</h3>
      <FormError message={error} />
      <FieldSet>
        <FieldLegend variant="label">Outcome</FieldLegend>
        <RadioGroup value={outcome} onValueChange={(v) => setOutcome(v as FlagOutcome)} className="sm:grid-cols-2">
          {(["cleared", "actioned"] as const).map((o) => (
            <FieldLabel key={o} htmlFor={`outcome-${o}`}>
              <Field orientation="horizontal">
                <div className="grid gap-1">
                  <span className="font-medium">{OUTCOME_LABELS[o]}</span>
                  <FieldDescription className="text-xs">{OUTCOME_HELP[o]}</FieldDescription>
                </div>
                <RadioGroupItem value={o} id={`outcome-${o}`} />
              </Field>
            </FieldLabel>
          ))}
        </RadioGroup>
      </FieldSet>
      <Field data-invalid={!!noteError}>
        <FieldLabel htmlFor="resolve-note">Note</FieldLabel>
        <Textarea id="resolve-note" rows={3} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} aria-invalid={!!noteError} />
        {noteError ? <FieldError>{noteError}</FieldError> : <FieldDescription>Staff only. Saved with the flag.</FieldDescription>}
      </Field>
      <div className="flex justify-end">
        <Button type="submit" disabled={pending}>
          {pending && <Spinner />}
          Resolve flag
        </Button>
      </div>
    </form>
  )
}

// The figures the risk rules record with a flag (backend/src/services/risk.ts).
const METRIC_LABELS: Record<string, string> = {
  count: "Count",
  largestKobo: "Largest",
  totalKobo: "Total",
  inflowKobo: "Received",
  outflowKobo: "Sent out",
  percent: "Sent out of received",
  newRecipients: "New recipients",
  daysSinceApproval: "Days since approval",
  windowStart: "Counted from",
}

function formatMetric(key: string, value: unknown) {
  if (key.endsWith("Kobo") && typeof value === "number") return formatNaira(value)
  if (key === "percent" && typeof value === "number") return `${value}%`
  if (key === "windowStart" && typeof value === "string") return formatDateTime(value)
  if (typeof value === "number") return value.toLocaleString("en-NG")
  return String(value)
}
