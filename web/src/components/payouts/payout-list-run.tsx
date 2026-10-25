"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { CircleCheck, Clock, RotateCcw, Send, TriangleAlert } from "lucide-react"
import { previewPayoutListRun, runPayoutList } from "@/app/(dashboard)/payout-lists/actions"
import { FormError } from "@/components/common/form-error"
import { NairaInput } from "@/components/common/naira-input"
import { useTransactionPin } from "@/components/transaction-pin/use-transaction-pin"
import { approvalLine } from "@/components/transfers/bulk-transfer-dialog"
import { ReviewRow, type SourceAccount } from "@/components/transfers/new-transfer-dialog"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldLabel } from "@/components/ui/field"
import { Label } from "@/components/ui/label"
import { NativeSelect } from "@/components/ui/native-select"
import { Spinner } from "@/components/ui/spinner"
import { useIdempotencyKey } from "@/hooks/use-idempotency-key"
import type { BulkPreview, PayoutListRunResult, PayoutListWithItems } from "@/lib/api/types"
import { formatNaira } from "@/lib/format"
import { amountProblem, people, type BeneficiaryLike } from "@/lib/payouts"
import { formatNairaInput, koboToInput, parseNairaToKobo } from "@/lib/transfers"
import { cn } from "@/lib/utils"
import { BeneficiaryName } from "./parts"

type RunRow = {
  key: string
  /** With its bank's uuid, which the run's key follows (keyedItems). */
  beneficiary: BeneficiaryLike & { bankUuid: string }
  /** The amount saved on the list. */
  savedKobo: number
  narration: string | null
  /** This run's amount, as typed. */
  amount: string
  /** Paid this time. */
  include: boolean
}

/** A row as the API takes it. */
type Item = { beneficiary: string; amountKobo: number; narration?: string }

type Done = { result: PayoutListRunResult; count: number; branch: string; kept: boolean }

/** The list's rows, each paid its saved amount. Rows whose beneficiary has gone can't be paid and are left out. */
const rowsFrom = (list: PayoutListWithItems): RunRow[] =>
  list.items.flatMap((i, n) =>
    i.beneficiary
      ? [
          {
            key: `${n}:${i.beneficiary._id}`,
            beneficiary: i.beneficiary,
            savedKobo: i.amountKobo,
            narration: i.narration,
            amount: formatNairaInput(koboToInput(i.amountKobo)),
            include: true,
          },
        ]
      : [],
  )

const toItems = (rows: RunRow[]): Item[] =>
  rows.map((r) => ({ beneficiary: r.beneficiary._id, amountKobo: parseNairaToKobo(r.amount) ?? 0, narration: r.narration ?? undefined }))

/**
 * The rows as a run's Idempotency-Key follows them, like the API's request hash and the bulk dialog's keyedItems:
 * each row's account number, bank, amount and narration. Not the beneficiary: a row pointed at another beneficiary
 * for the same account (deleted and saved again) after a lost answer is the same payment, and must replay.
 */
const keyedItems = (rows: RunRow[]) =>
  rows.map((r) => ({
    accountNumber: r.beneficiary.accountNumber,
    bankUuid: r.beneficiary.bankUuid,
    amountKobo: parseNairaToKobo(r.amount) ?? 0,
    narration: r.narration ?? null,
  }))

/** Row codes that mean "try again", not "this row is wrong": the bank couldn't answer a name check just now. */
const RETRYABLE = new Set(["NAME_CHECK_UNAVAILABLE"])

/** What a preview was worked out for: the account and exactly these rows. */
const previewKey = (branch: string, items: Item[]) => JSON.stringify([branch, items])

/**
 * The list's page: its people with this run's amounts (editable, or left out just this once), the account to pay
 * from, then a review with every name, fee, the total, the available balance and who has to approve (the bulk
 * transfer preview), and the transaction PIN. A run is an ordinary bulk transfer; the result links to it in
 * Transfers. Members who can't send money see the rows read-only.
 */
export function PayoutListRun({
  list,
  accounts,
  defaultBranchId,
  canRun,
  accountsNote,
}: {
  list: PayoutListWithItems
  /** Accounts the member can pay from, with balances. */
  accounts: SourceAccount[]
  defaultBranchId?: string
  canRun: boolean
  /** Shown instead of the account picker when the accounts couldn't be loaded. */
  accountsNote?: string
}) {
  const router = useRouter()
  const pin = useTransactionPin()
  const idempotency = useIdempotencyKey()
  const [rows, setRows] = useState(() => rowsFrom(list))
  const [sourceId, setSourceId] = useState(defaultBranchId ?? "")
  const [saveItems, setSaveItems] = useState(false)
  const [problems, setProblems] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string>()

  const [reviewing, setReviewing] = useState(false)
  // The API's dry run (fees, totals, balance, approval), for the rows and account it was worked out for.
  const [preview, setPreview] = useState<{ key: string; data: BulkPreview } | null>(null)
  const [previewing, setPreviewing] = useState(false)
  // Row problems from sending (INVALID_ROWS), by row key.
  const [serverErrors, setServerErrors] = useState<Record<string, { error: string; code?: string }>>({})
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<Done | null>(null)

  const gone = list.items.filter((i) => !i.beneficiary).length
  const included = rows.filter((r) => r.include)
  const items = toItems(included)
  const amountKobo = items.reduce((s, i) => s + i.amountKobo, 0)
  const changed = rows.some((r) => !r.include || parseNairaToKobo(r.amount) !== r.savedKobo) || gone > 0
  const source = accounts.find((a) => a.branch._id === sourceId)
  const current = preview?.key === previewKey(sourceId, items) ? preview.data : null

  // The review: each row paid this time with its fee, and what stops it being sent.
  const checked = included.map((r, i) => {
    const quoted = current?.rows[i]
    const sent = serverErrors[r.key]
    const problem = sent?.error ?? quoted?.error ?? undefined
    // A name the bank now gives differently (ACCOUNT_NAME_CHANGED) is never paid without a look: it's left out.
    const code = sent?.code ?? quoted?.code ?? undefined
    const renamed = code === "ACCOUNT_NAME_CHANGED"
    // The bank couldn't answer just now (NAME_CHECK_UNAVAILABLE): worth checking again rather than leaving out.
    const retryable = !!problem && RETRYABLE.has(code ?? "")
    // The name the API will pay, from the preview: the saved one for a beneficiary.
    const beneficiary = quoted?.accountName ? { ...r.beneficiary, accountName: quoted.accountName } : r.beneficiary
    return { ...r, beneficiary, kobo: items[i].amountKobo, fee: quoted, problem, renamed, retryable }
  })
  const failed = checked.filter((r) => r.problem).length
  const onlyRetryable = failed > 0 && checked.every((r) => !r.problem || r.retryable)
  const short = current?.blockers.find((b) => b.code === "INSUFFICIENT_BALANCE")
  const blockers = current?.blockers.filter((b) => b.code !== "INSUFFICIENT_BALANCE") ?? []

  const update = (key: string, patch: Partial<RunRow>) => {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)))
    setProblems((prev) => ({ ...prev, [key]: "" }))
  }

  function startOver() {
    setRows(rowsFrom(list))
    setSaveItems(false)
    setProblems({})
    setFormError(undefined)
  }

  /** The API's dry run for these rows from this account. */
  async function runPreview(next: Item[]) {
    setPreviewing(true)
    setError(undefined)
    try {
      const result = await previewPayoutListRun({ branch: sourceId, items: next })
      if (!result.ok) return setError(result.error)
      setPreview({ key: previewKey(sourceId, next), data: result.data })
    } catch {
      setError("We couldn't work out the fees. Check your connection and try again.")
    } finally {
      setPreviewing(false)
    }
  }

  function review() {
    const next: Record<string, string> = {}
    for (const r of included) {
      const problem = amountProblem(r.amount)
      if (problem) next[r.key] = problem
    }
    setProblems(next)
    if (!sourceId) return setFormError("Choose the account to pay from.")
    if (!included.length) return setFormError("Tick at least one person to pay.")
    if (Object.keys(next).length) return setFormError("Check the highlighted amounts.")
    setFormError(undefined)
    setServerErrors({})
    setError(undefined)
    setDone(null)
    setReviewing(true)
    // Always fresh: the balance, fees and approvers may have changed since the last look.
    void runPreview(items)
  }

  /** Asks again about every row (a passing bank outage clears), forgetting what the last send said about them. */
  function checkAgain() {
    setServerErrors({})
    setError(undefined)
    void runPreview(items)
  }

  /** Leaves the rows that can't be paid out of this run, and works the totals out again. */
  function leaveOut(keys: Set<string>) {
    const next = rows.map((r) => (keys.has(r.key) ? { ...r, include: false } : r))
    setRows(next)
    setServerErrors({})
    const left = next.filter((r) => r.include)
    if (!left.length) return setReviewing(false)
    void runPreview(toItems(left))
  }

  async function send() {
    if (!current || !source) return
    setBusy(true)
    setError(undefined)
    setServerErrors({})
    const request = { branch: sourceId, items }
    // The key follows what's paid: this list, the account and each row's account, amount and narration. Sending the
    // same again keeps it, whatever went wrong (a wrong PIN, a dropped response), so a retry can't pay twice;
    // changing any of them gets a new one. "Save these changes" isn't part of the payment (the API leaves it out of
    // what it compares a repeat with), so ticking it after a failed try still replays a run that already went.
    const idempotencyKey = idempotency.keyFor({ list: list._id, branch: sourceId, items: keyedItems(included) })
    const kept = saveItems && changed
    const forApproval = current.approval.needed
    const result = await pin.confirm({
      purpose: `pay ${formatNaira(current.amountKobo)} to ${people(items.length)} from ${source.branch.name}${forApproval ? ", for approval" : ""}`,
      confirmLabel: forApproval ? "Send for approval" : `Pay ${people(items.length)}`,
      run: (transactionPin) => runPayoutList(list._id, { ...request, saveItems: kept, idempotencyKey }, transactionPin),
    })
    setBusy(false)
    if (!result) return
    if (!result.ok) {
      // The key was used for other details: say so, and let a deliberate retry be a new request.
      if (result.code === "IDEMPOTENCY_KEY_REUSED") idempotency.reset()
      if (result.rows?.length) {
        setServerErrors(
          Object.fromEntries(result.rows.flatMap((r) => (included[r.row] ? [[included[r.row].key, { error: r.error, code: r.code }]] : []))),
        )
      }
      setError(result.error)
      // The balance or the approvers changed since the preview: show the figures as they are now.
      if (result.code === "INSUFFICIENT_BALANCE" || result.code === "NO_APPROVER") void runPreview(items)
      if (result.code === "PAYOUT_LIST_NOT_FOUND") router.refresh()
      return
    }
    idempotency.reset()
    setDone({ result: result.data, count: items.length, branch: source.branch.name, kept })
  }

  function closeReview() {
    if (busy) return
    setReviewing(false)
    if (done) {
      // Start the next payment from the list as it is now (its amounts may have just been saved). The result stays
      // on screen while the dialog closes; opening the review again clears it.
      setPreview(null)
      startOver()
    }
  }

  const renamed = checked.filter((r) => r.renamed)

  return (
    <section id="pay" aria-labelledby="pay-title" className="surface grid scroll-mt-24 overflow-hidden">
      <div className="flex flex-wrap items-end justify-between gap-5 p-5 sm:p-7">
        <div className="grid max-w-[52ch] gap-1">
          <h2 id="pay-title" className="type-display text-xl">
            {canRun ? "Pay this list" : "People on this list"}
          </h2>
          <p className="text-sm text-muted-foreground">
            {canRun
              ? "Change an amount just for this payment, or leave someone out this time. Nothing moves until you've checked it and confirmed with your PIN."
              : `${people(list.count)}, ${formatNaira(list.amountKobo)} before fees.`}
          </p>
        </div>
        {canRun &&
          (accounts.length ? (
            <Field className="w-full sm:w-96">
              <FieldLabel htmlFor="run-source">Pay from</FieldLabel>
              <NativeSelect id="run-source" value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
                {!sourceId && <option value="">Choose an account</option>}
                {accounts.map((a) => {
                  const available = a.balance?.availableKobo ?? a.balance?.amountKobo
                  return (
                    <option key={a._id} value={a.branch._id}>
                      {a.branch.name} · {a.accountNumber}
                      {available !== undefined ? ` · ${formatNaira(available)} available` : ""}
                    </option>
                  )
                })}
              </NativeSelect>
            </Field>
          ) : (
            <p className="max-w-sm text-sm text-muted-foreground">{accountsNote ?? "None of your accounts can send money yet."}</p>
          ))}
      </div>

      {gone > 0 && (
        <p className="mx-5 mb-4 flex items-start gap-2 rounded-lg bg-warning-subtle px-3 py-2.5 text-sm text-warning-foreground sm:mx-7">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          {gone === 1 ? "1 person on this list is" : `${gone} people on this list are`} no longer saved as a beneficiary, so they can&apos;t be paid.
          Edit the list to tidy it up.
        </p>
      )}

      <div className="border-t">
        <div
          className={cn(
            "hidden gap-4 bg-muted/60 px-7 py-2.5 text-xs font-medium text-muted-foreground md:grid",
            canRun ? "grid-cols-[1.25rem_minmax(0,1fr)_minmax(0,12rem)_12rem]" : "grid-cols-[minmax(0,1fr)_minmax(0,12rem)_10rem]",
          )}
        >
          {/* A wrapper keeps the grid cell: sr-only text alone is taken out of the layout. */}
          {canRun && (
            <span>
              <span className="sr-only">Pay this time</span>
            </span>
          )}
          <span>Beneficiary</span>
          <span>Narration</span>
          <span className="text-right">{canRun ? "Amount this time" : "Amount"}</span>
        </div>
        <ul className="divide-y">
          {rows.map((r) => {
            const label = r.beneficiary.nickname ?? r.beneficiary.accountName
            const kobo = parseNairaToKobo(r.amount)
            const differs = r.include && kobo !== null && kobo !== r.savedKobo
            const problem = problems[r.key]
            if (!canRun) {
              return (
                <li key={r.key} className="grid gap-x-4 gap-y-1 px-5 py-3.5 sm:px-7 md:grid-cols-[minmax(0,1fr)_minmax(0,12rem)_10rem] md:items-center">
                  <BeneficiaryName beneficiary={r.beneficiary} />
                  <span className="truncate text-sm text-muted-foreground">{r.narration ?? ""}</span>
                  <span className="font-medium figure md:text-right">{formatNaira(r.savedKobo)}</span>
                </li>
              )
            }
            return (
              <li
                key={r.key}
                className={cn(
                  "grid grid-cols-[1.25rem_minmax(0,1fr)] items-start gap-x-4 gap-y-3 px-5 py-3.5 transition-colors sm:px-7 md:grid-cols-[1.25rem_minmax(0,1fr)_minmax(0,12rem)_12rem] md:items-center",
                  !r.include && "bg-muted/40",
                  problem && "bg-destructive/5",
                )}
              >
                <Checkbox
                  className="mt-1 md:mt-0"
                  checked={r.include}
                  onCheckedChange={(v) => update(r.key, { include: v === true })}
                  aria-label={`Pay ${label} this time`}
                />
                <BeneficiaryName beneficiary={r.beneficiary} className={cn(!r.include && "opacity-60")} />
                <span className={cn("col-start-2 truncate text-sm text-muted-foreground md:col-start-auto", !r.include && "opacity-60")}>
                  {r.include ? (r.narration ?? "") : "Left out this time"}
                </span>
                <div className="col-start-2 grid gap-1 md:col-start-auto">
                  <NairaInput
                    aria-label={`Amount for ${label} this time`}
                    value={r.amount}
                    disabled={!r.include}
                    invalid={!!problem}
                    className="text-right"
                    onChange={(amount) => update(r.key, { amount })}
                  />
                  {problem ? (
                    <span className="text-xs text-destructive">{problem}</span>
                  ) : (
                    differs && <span className="text-right text-xs text-muted-foreground">List: {formatNaira(r.savedKobo)}</span>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      </div>

      {canRun && (
        <div className="grid gap-4 border-t bg-muted/40 px-5 py-4 sm:px-7">
          <FormError message={formError} />
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="grid gap-2">
              <p className="text-sm">
                {included.length === rows.length ? `Paying ${people(rows.length)}` : `Paying ${included.length} of ${rows.length}`},{" "}
                <span className="figure font-medium">{formatNaira(amountKobo)}</span> before fees
              </p>
              {changed && (
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <Label className="flex items-center gap-2 text-sm font-normal">
                    <Checkbox checked={saveItems} onCheckedChange={(v) => setSaveItems(v === true)} />
                    Save these changes to the list
                  </Label>
                  <Button type="button" variant="ghost" size="sm" onClick={startOver}>
                    <RotateCcw data-icon="inline-start" aria-hidden />
                    Use the list&apos;s amounts
                  </Button>
                </div>
              )}
            </div>
            <Button onClick={review} disabled={!accounts.length || previewing}>
              {previewing && !reviewing ? <Spinner /> : <Send data-icon="inline-start" aria-hidden />}
              Review payment
            </Button>
          </div>
        </div>
      )}

      <Dialog open={reviewing} onOpenChange={(open) => !open && closeReview()}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-3xl" showCloseButton={!busy}>
          {done ? (
            <DoneView done={done} onClose={closeReview} />
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Check and pay</DialogTitle>
                <DialogDescription>Check each name is who you mean to pay. Nothing moves until you confirm with your PIN.</DialogDescription>
              </DialogHeader>

              <FormError message={error} />

              {!current ? (
                previewing ? (
                  <p role="status" className="inline-flex min-h-24 items-center gap-2 text-sm text-muted-foreground">
                    <Spinner /> Working out the fees and who needs to approve
                  </p>
                ) : (
                  <div className="flex min-h-24 items-center">
                    <Button variant="outline" onClick={() => runPreview(items)}>
                      Try again
                    </Button>
                  </div>
                )
              ) : (
                <div className="grid gap-4">
                  <dl className="divide-y rounded-xl border text-sm">
                    <ReviewRow label="List" value={list.title} />
                    <ReviewRow label="From" value={source ? `${source.branch.name} · ${source.accountNumber}` : current.branch.name} />
                    <ReviewRow
                      label="Amount"
                      value={
                        <span className="grid justify-items-end">
                          <span className="figure">{formatNaira(current.amountKobo)}</span>
                          <span className="text-xs text-muted-foreground">to {people(current.count)}</span>
                        </span>
                      }
                    />
                    <ReviewRow
                      label="Fees"
                      value={
                        <span className="grid justify-items-end">
                          <span className="figure">{formatNaira(current.feeKobo)}</span>
                          {current.stampDutyKobo > 0 && (
                            <span className="text-xs text-muted-foreground">
                              includes <span className="figure">{formatNaira(current.stampDutyKobo)}</span> stamp duty
                            </span>
                          )}
                        </span>
                      }
                    />
                    <ReviewRow label="Total from the account" value={<span className="type-display text-xl figure">{formatNaira(current.totalKobo)}</span>} />
                    <ReviewRow
                      label="Available"
                      value={
                        current.availableKobo !== null ? (
                          <span className={cn("figure", short && "text-destructive")}>{formatNaira(current.availableKobo)}</span>
                        ) : (
                          <span className="text-muted-foreground">Couldn&apos;t be checked just now</span>
                        )
                      }
                    />
                    <ReviewRow
                      label="Approval"
                      value={
                        <span className="grid justify-items-end text-right">
                          <span className="font-medium">{approvalLine(current.approval)}</span>
                          {current.approval.needed && current.approval.earlierKobo > 0 && (
                            <span className="text-xs text-muted-foreground">
                              Counts the <span className="figure">{formatNaira(current.approval.earlierKobo)}</span> you&apos;ve sent from{" "}
                              {current.branch.name} in the last 24 hours
                            </span>
                          )}
                          {current.approval.needed && <span className="text-xs text-muted-foreground">The money is held until it&apos;s approved</span>}
                        </span>
                      }
                    />
                  </dl>

                  {saveItems && changed && (
                    <p className="rounded-lg bg-muted px-3 py-2.5 text-sm text-muted-foreground">
                      Once it&apos;s sent, the list keeps these amounts
                      {included.length < rows.length ? ", without the people left out this time" : ""}.
                    </p>
                  )}

                  {short && (
                    <p className="text-sm text-destructive">
                      With {formatNaira(current.feeKobo)} in fees this needs {formatNaira(current.totalKobo)}. {current.branch.name} has{" "}
                      {formatNaira(current.availableKobo ?? 0)} available.
                    </p>
                  )}
                  {blockers.map((b) => (
                    <p key={b.code ?? b.error} className="text-sm text-destructive">
                      {b.error}
                    </p>
                  ))}

                  {renamed.length > 0 && (
                    <p role="alert" className="rounded-lg bg-warning-subtle px-3 py-2.5 text-sm text-warning-foreground">
                      The bank now gives a different name for {renamed.length === 1 ? "1 account" : `${renamed.length} accounts`}. Leave{" "}
                      {renamed.length === 1 ? "it" : "them"} out, then check the beneficiary before paying {renamed.length === 1 ? "it" : "them"}.
                    </p>
                  )}

                  {failed > 0 && (
                    <div
                      className={cn(
                        "flex flex-wrap items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-sm",
                        onlyRetryable ? "bg-warning-subtle" : "bg-destructive-subtle",
                      )}
                    >
                      <p className={onlyRetryable ? "text-warning-foreground" : "text-destructive"}>
                        {onlyRetryable
                          ? `The bank couldn't check ${failed === 1 ? "1 account" : `${failed} accounts`} just now. Check again in a moment, or leave ${failed === 1 ? "it" : "them"} out this time to pay the rest.`
                          : `${failed === 1 ? "1 person can't" : `${failed} people can't`} be paid as things are. Leave them out this time to pay the rest.`}
                      </p>
                      <div className="flex gap-2">
                        <Button variant="outline" size="sm" onClick={checkAgain} disabled={busy || previewing}>
                          Check again
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => leaveOut(new Set(checked.filter((r) => r.problem).map((r) => r.key)))}
                          disabled={busy || previewing}
                        >
                          Leave {onlyRetryable && failed === 1 ? "it" : "them"} out
                        </Button>
                      </div>
                    </div>
                  )}

                  <div className="overflow-hidden rounded-xl border">
                    <div className="max-h-80 overflow-y-auto">
                      <table className="w-full text-sm">
                        <caption className="sr-only">Each transfer, with the saved account name and the fee</caption>
                        <thead className="text-xs text-muted-foreground">
                          <tr className="border-b">
                            <th scope="col" className="px-4 py-2 text-left font-medium">To</th>
                            <th scope="col" className="px-2 py-2 text-right font-medium">Amount</th>
                            <th scope="col" className="px-4 py-2 text-right font-medium">Fee</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y">
                          {checked.map((r) => (
                            <tr key={r.key} className={cn(r.renamed || r.retryable ? "bg-warning-subtle/60" : r.problem && "bg-destructive/5")}>
                              <td className="px-4 py-2 align-top">
                                <BeneficiaryName beneficiary={r.beneficiary} />
                                {r.problem ? (
                                  <span className={cn("block text-xs", r.renamed || r.retryable ? "text-warning-foreground" : "text-destructive")}>
                                    {r.problem}
                                  </span>
                                ) : (
                                  r.narration && <span className="block text-xs text-muted-foreground">{r.narration}</span>
                                )}
                              </td>
                              <td className="px-2 py-2 text-right align-top">
                                <span className="figure">{formatNaira(r.kobo)}</span>
                                {r.kobo !== r.savedKobo && (
                                  <span className="block text-xs text-muted-foreground">
                                    List: <span className="figure">{formatNaira(r.savedKobo)}</span>
                                  </span>
                                )}
                              </td>
                              <td className="px-4 py-2 text-right align-top figure">{r.fee && formatNaira(r.fee.feeKobo)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}

              {current && previewing && (
                <p role="status" className="inline-flex items-center gap-2 text-sm text-muted-foreground">
                  <Spinner /> Working out the fees again
                </p>
              )}

              <DialogFooter>
                <Button variant="outline" onClick={closeReview} disabled={busy}>
                  Back
                </Button>
                <Button onClick={send} disabled={busy || previewing || !current || failed > 0 || !!short || blockers.length > 0}>
                  {busy ? <Spinner /> : <Send data-icon="inline-start" aria-hidden />}
                  {busy ? "Sending" : current?.approval.needed ? `Send ${people(items.length)} for approval` : `Pay ${people(items.length)}`}
                </Button>
              </DialogFooter>
              {pin.dialog}
            </>
          )}
        </DialogContent>
      </Dialog>
    </section>
  )
}

/** After sending: where the payment is, and a link to its bulk transfer (or transfer) in Transfers. */
function DoneView({ done, onClose }: { done: Done; onClose: () => void }) {
  const batch = done.result.batch
  const transfers = batch?.items ?? done.result.items ?? []
  const waiting = batch ? batch.statusCounts.pending_approval > 0 : transfers[0]?.status === "pending_approval"
  const failedSingle = !batch && transfers[0]?.status === "failed"
  const href = batch ? `/transfers?batch=${batch._id}` : transfers[0] ? `/transfers?transfer=${transfers[0]._id}` : "/transfers"
  const count = done.count === 1 ? "1 transfer" : `${done.count} transfers`
  const Icon = failedSingle ? TriangleAlert : waiting ? Clock : CircleCheck

  return (
    <>
      <DialogHeader>
        <span
          className={cn(
            "mb-2 grid size-11 place-items-center rounded-xl",
            failedSingle ? "bg-destructive-subtle text-destructive" : waiting ? "bg-warning-subtle text-warning-foreground" : "bg-pop-subtle text-foreground",
          )}
          aria-hidden
        >
          <Icon className="size-5" />
        </span>
        <DialogTitle className="type-display text-2xl">{failedSingle ? "The transfer failed" : waiting ? "Sent for approval" : "Payment on its way"}</DialogTitle>
        <DialogDescription>
          {failedSingle
            ? `${transfers[0]?.failureReason ?? "The bank couldn't complete it"}. The money stays in ${done.branch}.`
            : waiting
              ? `${count} from ${done.branch} ${done.count === 1 ? "is" : "are"} waiting for approval. The money is held until ${done.count === 1 ? "it's" : "they're"} approved.`
              : `${count} from ${done.branch} ${done.count === 1 ? "is" : "are"} on the way.`}
          {done.kept && " The list keeps the amounts you paid."}
        </DialogDescription>
      </DialogHeader>
      {batch && (
        <dl className="divide-y rounded-xl border text-sm">
          <ReviewRow label="Bulk transfer" value={batch.title ?? "Untitled"} />
          <ReviewRow label="Amount" value={<span className="figure">{formatNaira(batch.amountKobo)}</span>} />
          <ReviewRow label="Total with fees" value={<span className="figure font-medium">{formatNaira(batch.totalKobo)}</span>} />
        </dl>
      )}
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Done
        </Button>
        <Button asChild>
          <Link href={href}>{batch ? "View bulk transfer" : "View transfer"}</Link>
        </Button>
      </DialogFooter>
    </>
  )
}
