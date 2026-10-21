"use client"

import { useEffect, useState } from "react"
import { Plus, Sparkles, X } from "lucide-react"
import { toast } from "sonner"
import { recordPayment, removePayment, setReminders, suggestedPayments } from "@/app/(dashboard)/invoices/actions"
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
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group"
import { NativeSelect } from "@/components/ui/native-select"
import { Spinner } from "@/components/ui/spinner"
import type { Invoice, InvoicePayment, PaymentMethod, SuggestedPayment } from "@/lib/api/types"
import { formatDate, formatNaira, formatShortDate } from "@/lib/format"
import { dueLabel, formatDay, METHOD_LABELS, todayInLagos } from "@/lib/invoices"
import { koboToInput, parseNairaToKobo } from "@/lib/transfers"
import { cn } from "@/lib/utils"

/** What's owed and what's been paid, with recording and linking payments for members who manage invoices. */
export function PaymentsPanel({ invoice, canManage }: { invoice: Invoice; canManage: boolean }) {
  const [recordOpen, setRecordOpen] = useState(false)
  const [removing, setRemoving] = useState<InvoicePayment | null>(null)
  const [busy, setBusy] = useState(false)
  const unpaid = invoice.status === "open" || invoice.status === "partially_paid"
  const paidShare = invoice.totalKobo > 0 ? Math.min(100, Math.round((invoice.paidKobo / invoice.totalKobo) * 100)) : 0

  async function remove() {
    if (!removing) return
    setBusy(true)
    const result = await removePayment(invoice._id, removing._id)
    setBusy(false)
    if (!result.ok) return toast.error(result.error)
    toast.success("Payment removed from the invoice.")
    setRemoving(null)
  }

  return (
    <section aria-labelledby="payments-title" className="surface grid gap-6 p-6">
      <div className="grid gap-1">
        <h2 id="payments-title" className="text-sm text-muted-foreground">
          {invoice.status === "paid" ? "Paid in full" : invoice.status === "void" ? "Void" : "Balance due"}
        </h2>
        <p className="type-display text-4xl figure">
          {formatNaira(invoice.status === "paid" ? invoice.totalKobo : invoice.status === "void" ? 0 : invoice.balanceKobo)}
        </p>
        <p className={cn("text-sm", invoice.overdue ? "text-destructive" : "text-muted-foreground")}>
          {invoice.status === "paid" && invoice.paidAt
            ? `Paid ${formatDate(invoice.paidAt)}`
            : invoice.status === "void"
              ? `Voided ${formatDate(invoice.voidedAt ?? undefined)}`
              : invoice.status === "draft"
                ? `Due ${formatDay(invoice.dueDate)} once sent`
                : `${dueLabel(invoice.dueDate)}, ${formatDay(invoice.dueDate)}`}
        </p>
      </div>

      {invoice.status !== "draft" && invoice.status !== "void" && (
        <div className="grid gap-2">
          <div
            className="h-1.5 overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-label="Paid so far"
            aria-valuenow={paidShare}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div className="h-full rounded-full bg-success transition-[width] duration-300" style={{ width: `${paidShare}%` }} />
          </div>
          <p className="flex justify-between text-xs text-muted-foreground">
            <span>
              <span className="figure">{formatNaira(invoice.paidKobo)}</span> paid
            </span>
            <span>
              of <span className="figure">{formatNaira(invoice.totalKobo)}</span>
            </span>
          </p>
        </div>
      )}

      {invoice.payments.length > 0 && (
        <div className="grid gap-2">
          <h3 className="text-sm font-medium">Payments</h3>
          <ul className="divide-y rounded-xl border">
            {invoice.payments.map((p) => (
              <li key={p._id} className="flex items-start gap-3 px-4 py-3">
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {METHOD_LABELS[p.method]}
                    {p.auto && (
                      <Badge variant="success">
                        <Sparkles aria-hidden />
                        Matched
                      </Badge>
                    )}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {formatShortDate(p.paidAt)}
                    {p.recordedBy ? `, recorded by ${p.recordedBy.name}` : p.auto ? ", from the narration" : ""}
                    {p.note ? `. ${p.note}` : ""}
                  </span>
                </span>
                <span className="text-sm font-medium figure">{formatNaira(p.amountKobo)}</span>
                {canManage && invoice.status !== "void" && (
                  <Button variant="ghost" size="icon-xs" aria-label={`Remove the ${formatNaira(p.amountKobo)} payment`} onClick={() => setRemoving(p)}>
                    <X aria-hidden />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {unpaid && (
        <p className="text-sm text-muted-foreground">
          Transfers into {invoice.payTo ? invoice.payTo.accountNumber : "your account"} with <span className="font-medium text-foreground figure">{invoice.number}</span> in
          the narration are matched to this invoice by themselves.
        </p>
      )}

      {canManage && unpaid && (
        <Button variant="outline" onClick={() => setRecordOpen(true)}>
          <Plus data-icon="inline-start" aria-hidden />
          Record a payment
        </Button>
      )}

      {canManage && unpaid && <RemindersToggle invoice={invoice} />}

      <RecordPaymentDialog invoice={invoice} open={recordOpen} onOpenChange={setRecordOpen} />

      <AlertDialog open={!!removing} onOpenChange={(o) => !o && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this payment?</AlertDialogTitle>
            <AlertDialogDescription>
              {removing?.transaction
                ? "The transfer stays in your transactions; it just won't count towards this invoice. The balance due goes back up."
                : "The balance due goes back up. Your customer isn't told."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Keep it</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={(e) => {
                e.preventDefault()
                remove()
              }}
            >
              {busy && <Spinner />}
              Remove payment
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}

function RemindersToggle({ invoice }: { invoice: Invoice }) {
  const [enabled, setEnabled] = useState(invoice.reminders.enabled)
  const [busy, setBusy] = useState(false)

  async function toggle(next: boolean) {
    setEnabled(next)
    setBusy(true)
    const result = await setReminders(invoice._id, next)
    setBusy(false)
    if (!result.ok) {
      setEnabled(!next)
      toast.error(result.error)
    }
  }

  return (
    <label className="flex items-start gap-2.5 border-t pt-5 text-sm">
      <Checkbox className="mt-0.5" checked={enabled} disabled={busy || !invoice.customer.email} onCheckedChange={(v) => toggle(v === true)} />
      <span className="grid gap-0.5">
        Automatic reminders
        <span className="text-muted-foreground">
          {!invoice.customer.email
            ? "Add the customer's email to send reminders."
            : invoice.reminders.lastSentAt
              ? `Last reminder ${formatDate(invoice.reminders.lastSentAt)}.`
              : "Before the due date, on the day, then 3 and 10 days after."}
        </span>
      </span>
    </label>
  )
}

const MANUAL_METHODS: PaymentMethod[] = ["cash", "pos", "transfer", "cheque", "other"]

function RecordPaymentDialog({ invoice, open, onOpenChange }: { invoice: Invoice; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [mode, setMode] = useState<"match" | "manual">("match")
  const [suggestions, setSuggestions] = useState<SuggestedPayment[] | null>(null)
  const [picked, setPicked] = useState<string | null>(null)
  const [amount, setAmount] = useState(koboToInput(invoice.balanceKobo))
  const [method, setMethod] = useState<PaymentMethod>("cash")
  const [paidAt, setPaidAt] = useState(todayInLagos())
  const [note, setNote] = useState("")
  const [amountError, setAmountError] = useState<string>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  // Suggestions load each time the dialog opens, so a transfer that just landed shows up.
  useEffect(() => {
    if (!open) return
    let stale = false
    suggestedPayments(invoice._id).then((r) => {
      if (stale) return
      const items = r.ok ? r.data : []
      setSuggestions(items)
      if (items.length === 0) setMode("manual")
    })
    return () => {
      stale = true
    }
  }, [open, invoice._id])

  function reset() {
    setMode("match")
    setSuggestions(null)
    setPicked(null)
    setAmount(koboToInput(invoice.balanceKobo))
    setMethod("cash")
    setPaidAt(todayInLagos())
    setNote("")
    setAmountError(undefined)
    setError(undefined)
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(undefined)
    let input: Parameters<typeof recordPayment>[1]
    if (mode === "match") {
      if (!picked) return setError("Choose the transfer that paid this invoice.")
      input = { transactionId: picked }
    } else {
      const kobo = parseNairaToKobo(amount)
      if (kobo === null || kobo < 1) return setAmountError("Enter the amount received.")
      if (kobo > invoice.balanceKobo) return setAmountError(`That's more than the ${formatNaira(invoice.balanceKobo)} still owed.`)
      setAmountError(undefined)
      input = { amountKobo: kobo, method, paidAt, note: note.trim() || undefined }
    }
    setBusy(true)
    const result = await recordPayment(invoice._id, input)
    setBusy(false)
    if (!result.ok) return setError(result.error)
    toast.success(
      result.data.status === "paid"
        ? `${invoice.number} is paid.${invoice.customer.email ? " We've emailed the customer a receipt." : ""}`
        : `Payment recorded. ${formatNaira(result.data.balanceKobo)} is still due.`,
    )
    onOpenChange(false)
    reset()
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next)
        if (!next) reset()
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Record a payment</DialogTitle>
          <DialogDescription>
            <span className="figure">{formatNaira(invoice.balanceKobo)}</span> is still due on {invoice.number}.
          </DialogDescription>
        </DialogHeader>
        <FormError message={error} />

        <div role="radiogroup" aria-label="How it was paid" className="inline-flex h-9 w-fit items-center gap-0.5 rounded-full bg-muted p-0.5">
          {(["match", "manual"] as const).map((v) => (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={mode === v}
              onClick={() => setMode(v)}
              className={cn(
                "h-8 rounded-full px-4 text-sm font-medium transition-colors duration-150 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                mode === v ? "bg-card text-foreground shadow-surface" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {v === "match" ? "Transfer to your account" : "Cash, POS or other"}
            </button>
          ))}
        </div>

        <form id="record-payment" onSubmit={submit} noValidate className="grid gap-5">
          {mode === "match" ? (
            suggestions === null ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner /> Looking for matching payments
              </p>
            ) : suggestions.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No unlinked payment looks like this one: none for {formatNaira(invoice.balanceKobo)} or from {invoice.customer.name}. If they paid cash or by POS, record it by hand.
              </p>
            ) : (
              <fieldset className="grid gap-2">
                <legend className="mb-2 text-sm text-muted-foreground">Payments into your accounts that look like they&apos;re for this invoice.</legend>
                {suggestions.map((s) => (
                  <label
                    key={s._id}
                    className={cn(
                      "flex cursor-pointer items-start gap-3 rounded-xl border p-3.5 transition-colors has-[:checked]:border-primary has-[:checked]:bg-brand-subtle/40 has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50",
                    )}
                  >
                    <input type="radio" name="transaction" value={s._id} checked={picked === s._id} onChange={() => setPicked(s._id)} className="mt-1 accent-primary" />
                    <span className="grid min-w-0 flex-1 gap-0.5">
                      <span className="flex flex-wrap items-center gap-2 font-medium">
                        {s.counterparty.name ?? "Unknown payer"}
                        {s.exactAmount && <Badge variant="success">Exact amount</Badge>}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">
                        {formatShortDate(s.occurredAt)}
                        {s.counterparty.bankName ? ` · ${s.counterparty.bankName}` : ""}
                        {s.narration ? ` · ${s.narration}` : ""}
                      </span>
                    </span>
                    <span className="text-sm font-medium figure">{formatNaira(s.amountKobo)}</span>
                  </label>
                ))}
              </fieldset>
            )
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field data-invalid={!!amountError}>
                  <FieldLabel htmlFor="payment-amount">Amount</FieldLabel>
                  <InputGroup>
                    <InputGroupAddon>
                      <InputGroupText>₦</InputGroupText>
                    </InputGroupAddon>
                    <InputGroupInput
                      id="payment-amount"
                      inputMode="decimal"
                      autoComplete="off"
                      className="figure"
                      value={amount}
                      aria-invalid={!!amountError}
                      onChange={(e) => setAmount(e.target.value)}
                    />
                  </InputGroup>
                  {amountError && <FieldError>{amountError}</FieldError>}
                </Field>
                <Field>
                  <FieldLabel htmlFor="payment-method">Paid by</FieldLabel>
                  <NativeSelect id="payment-method" value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
                    {MANUAL_METHODS.map((m) => (
                      <option key={m} value={m}>
                        {m === "transfer" ? "Transfer to another account" : METHOD_LABELS[m]}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
              </div>
              <Field>
                <FieldLabel htmlFor="payment-date">Date received</FieldLabel>
                <Input id="payment-date" type="date" max={todayInLagos()} value={paidAt} onChange={(e) => e.target.value && setPaidAt(e.target.value)} />
              </Field>
              <Field>
                <FieldLabel htmlFor="payment-note">Note</FieldLabel>
                <Input id="payment-note" maxLength={300} placeholder="Receipt number, who took it" value={note} onChange={(e) => setNote(e.target.value)} />
              </Field>
            </>
          )}
        </form>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form="record-payment" disabled={busy || (mode === "match" && !suggestions?.length)}>
            {busy && <Spinner />}
            {mode === "match" ? "Link payment" : "Record payment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
