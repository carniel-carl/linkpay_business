"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { BookUser, FileUp, Send, X } from "lucide-react"
import { toast } from "sonner"
import { createBulkTransfer, listBanks, previewBulkTransfer, resolveAccounts } from "@/app/(dashboard)/transfers/actions"
import { FormError } from "@/components/common/form-error"
import { NairaInput } from "@/components/common/naira-input"
import { BeneficiaryPickerDialog } from "@/components/payouts/beneficiary-picker-dialog"
import { BeneficiaryName } from "@/components/payouts/parts"
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
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { NativeSelect } from "@/components/ui/native-select"
import { Progress } from "@/components/ui/progress"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { useTransactionPin } from "@/components/transaction-pin/use-transaction-pin"
import { useIdempotencyKey } from "@/hooks/use-idempotency-key"
import { messageForCode } from "@/lib/api/errors"
import type { Bank, Beneficiary, BulkPreview, BulkRowError, ResolvedAccount } from "@/lib/api/types"
import {
  csvHref,
  dropLines,
  MAX_CSV_BYTES,
  MAX_CSV_ROWS as MAX_ROWS,
  parseTransferCsv,
  TRANSFER_CSV_TEMPLATE,
  type TransferCsvRow as Row,
} from "@/lib/bulk-csv"
import { formatNaira } from "@/lib/format"
import { amountProblem, MAX_NARRATION, people as peopleCount } from "@/lib/payouts"
import { BULK_CHECK_SLICE, parseNairaToKobo } from "@/lib/transfers"
import { cn } from "@/lib/utils"
import { ResolvedName, ReviewRow, type SourceAccount } from "./new-transfer-dialog"

/** A saved beneficiary added to the transfer, with this payment's amount and narration as typed. */
type SavedRow = { key: string; beneficiary: Beneficiary; amount: string; narration: string }

/**
 * One row of the transfer: a saved beneficiary (paid under its saved name, so no name enquiry) or an account
 * from the CSV. Saved beneficiaries come first, as on the form. `key` survives re-renders, for row errors.
 */
type Entry = { key: string; amountKobo: number | null; narration?: string } & (
  | { kind: "saved"; saved: SavedRow }
  | { kind: "account"; row: Row }
)

/** A name enquiry or fee quote: the answer, or why it failed. */
type Checked<T> = { data?: T; error?: string }

/** "Bank:account number", the key a name enquiry is kept under. */
const lookupKey = (r: Row) => `${r.bank?.uuid}:${r.accountNumber}`

const toEntries = (saved: SavedRow[], rows: Row[]): Entry[] => [
  ...saved.map((s): Entry => ({
    kind: "saved",
    key: s.key,
    saved: s,
    amountKobo: parseNairaToKobo(s.amount),
    narration: s.narration.trim().slice(0, MAX_NARRATION) || undefined,
  })),
  ...rows.map((r): Entry => ({ kind: "account", key: `line:${r.line}`, row: r, amountKobo: r.amountKobo, narration: r.narration })),
]

/**
 * The rows as they're paid, without the names: what a preview was worked out for, and what the Idempotency-Key
 * follows. A saved beneficiary is its id; an account is its number and bank.
 */
const paidItems = (list: Entry[]) =>
  list.map((e) =>
    e.kind === "saved"
      ? { beneficiary: e.saved.beneficiary._id, amountKobo: e.amountKobo!, narration: e.narration }
      : { accountNumber: e.row.accountNumber, bankUuid: e.row.bank!.uuid, amountKobo: e.amountKobo!, narration: e.narration },
  )

/** What a preview was worked out for: the account and the rows, but not the names (they can be checked again). */
const previewKey = (branch: string, list: Entry[]) => JSON.stringify([branch, paidItems(list)])

/**
 * The rows as the API takes them. Each account carries the name the member is looking at, so the API can refuse
 * one whose name has changed; a saved beneficiary is paid under its saved name.
 */
const apiItems = (list: Entry[], names: Record<string, Checked<ResolvedAccount>>) =>
  list.map((e) =>
    e.kind === "saved"
      ? { beneficiary: e.saved.beneficiary._id, amountKobo: e.amountKobo!, narration: e.narration }
      : {
          accountNumber: e.row.accountNumber,
          bankUuid: e.row.bank!.uuid,
          amountKobo: e.amountKobo!,
          narration: e.narration,
          accountName: names[lookupKey(e.row)]?.data?.accountName,
        },
  )

/** A row's problem from the API, worded for this review. */
const rowMessage = (code: string | null | undefined, error: string) =>
  code === "BENEFICIARY_NOT_FOUND"
    ? "This beneficiary is no longer saved. Remove the row, or add their account to the CSV."
    : messageForCode(code ?? undefined, error)

/** "Ada, Bola or Chidi". */
const joinOr = (names: string[]) => (names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`)

/** "Needs approval from Ada or Bola, then Chidi", or "Sends straight away". Also used by payout list runs. */
export function approvalLine(approval: BulkPreview["approval"]) {
  if (!approval.needed) return "Sends straight away"
  const level = (l: BulkPreview["approval"]["levels"][number]) => {
    if (!l.approvers.length) return "someone who can approve transfers"
    if (l.any && l.approvers.length > 3) return "anyone who can approve transfers"
    const names = l.approvers.map((a) => a.name)
    return names.length > 3 ? `${names.slice(0, 2).join(", ")} or ${names.length - 2} others` : joinOr(names)
  }
  return `Needs approval from ${approval.levels.map(level).join(", then ")}`
}

/**
 * Pay many people from one account: saved beneficiaries and an uploaded or pasted CSV of accounts, then check
 * every new account's name and every fee in a review before sending it for approval or straight away.
 */
export function BulkTransferDialog({ accounts, defaultBranchId, children }: { accounts: SourceAccount[]; defaultBranchId?: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState<"details" | "review">("details")
  const [banks, setBanks] = useState<Bank[] | null>(null)
  const [sourceId, setSourceId] = useState(defaultBranchId ?? accounts[0]?.branch._id ?? "")
  const [title, setTitle] = useState("")
  const [text, setText] = useState("")
  const [saved, setSaved] = useState<SavedRow[]>([])
  // Amount problems on saved beneficiaries' rows, shown once Continue is pressed.
  const [savedErrors, setSavedErrors] = useState<Record<string, string>>({})
  // "Save new accounts to beneficiaries" (saveBeneficiaries).
  const [saveNew, setSaveNew] = useState(false)
  // Name enquiries by bank and account number, kept while the dialog is open, so going back to fix a row only
  // checks what changed; failed checks are tried again.
  const [lookups, setLookups] = useState<Record<string, Checked<ResolvedAccount>>>({})
  // The API's dry run of the batch (fees, totals, balance, approval), for the rows it was worked out for.
  const [preview, setPreview] = useState<{ key: string; data: BulkPreview } | null>(null)
  const [previewing, setPreviewing] = useState(false)
  // Accounts the bank now gives a different name for, with the name the member checked before. Nothing can be
  // sent until they've looked at the new names.
  const [renamed, setRenamed] = useState<Record<string, string>>({})
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  // Row problems from sending (INVALID_ROWS), by row key.
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const idempotency = useIdempotencyKey()
  const pin = useTransactionPin()
  // Bumped to stop a check that's running (the dialog closed, or a newer check started).
  const checkRun = useRef(0)

  useEffect(() => {
    if (!open || banks) return
    listBanks().then((r) => (r.ok ? setBanks(r.data) : setError(r.error)))
  }, [open, banks])

  const rows = useMemo(() => (banks ? parseTransferCsv(text, banks) : []), [text, banks])
  const entries = toEntries(saved, rows)
  const source = accounts.find((a) => a.branch._id === sourceId)
  const totalKobo = entries.reduce((s, e) => s + (e.amountKobo ?? 0), 0)
  const csvKobo = rows.reduce((s, r) => s + (r.amountKobo ?? 0), 0)
  const savedKobo = totalKobo - csvKobo
  const invalid = rows.filter((r) => r.error || serverErrors[`line:${r.line}`]).length
  const tooMany = entries.length > MAX_ROWS
  const room = MAX_ROWS - entries.length
  const added = new Set(saved.map((s) => s.beneficiary._id))
  // The CSV can't be read until the banks have loaded.
  const waitingForBanks = !banks && text.trim().length > 0
  // Only the CSV's accounts can be new; saved beneficiaries are saved already.
  const saveAccounts = saveNew && rows.length > 0
  const spendable = source?.balance?.availableKobo ?? source?.balance?.amountKobo
  const checking = progress !== null || previewing
  // Only a preview of exactly these rows from this account counts.
  const current = preview?.key === previewKey(sourceId, entries) ? preview.data : null

  // The review: each row with its account name and fee, and what stops it being sent.
  const checked = entries.map((e, i) => {
    const quoted = current?.rows[i]
    if (e.kind === "saved") {
      const quotedError = quoted?.error ? rowMessage(quoted.code, quoted.error) : undefined
      const problem = serverErrors[e.key] || quotedError || (!quoted ? "Not checked yet." : undefined)
      return { ...e, account: undefined, fee: quoted, problem, was: undefined }
    }
    const lookup = lookups[lookupKey(e.row)]
    // A changed name isn't a fault to fix: the row shows the new name and waits for the member to check it.
    const quotedError = quoted?.code === "ACCOUNT_NAME_CHANGED" || !quoted?.error ? undefined : rowMessage(quoted.code, quoted.error)
    const problem = e.row.error || serverErrors[e.key] || lookup?.error || quotedError || (!lookup?.data || !quoted ? "Not checked yet." : undefined)
    return { ...e, account: lookup?.data, fee: quoted, problem, was: renamed[lookupKey(e.row)] }
  })
  const failed = checked.filter((r) => r.problem).length
  // Rows waiting for a changed name to be checked, and how many accounts that is.
  const changedRows = checked.filter((r) => r.kind === "account" && r.was !== undefined && !r.problem)
  const changed = changedRows.length
  const changedAccounts = new Set(changedRows.map((r) => (r.kind === "account" ? lookupKey(r.row) : r.key))).size
  const short = current?.blockers.find((b) => b.code === "INSUFFICIENT_BALANCE")
  const blockers = current?.blockers.filter((b) => b.code !== "INSUFFICIENT_BALANCE") ?? []
  const available = current?.availableKobo ?? spendable

  function reset() {
    checkRun.current++
    setStep("details")
    setText("")
    setTitle("")
    setSaved([])
    setSavedErrors({})
    setSaveNew(false)
    setLookups({})
    setPreview(null)
    setRenamed({})
    setProgress(null)
    setServerErrors({})
    setError(undefined)
    idempotency.reset()
  }

  async function onFile(file?: File) {
    if (!file) return
    if (file.size > MAX_CSV_BYTES) return setError("That file is too big. Keep it under 500 KB (about 200 rows).")
    setServerErrors({})
    setText(await file.text())
  }

  /** Saved beneficiaries picked to pay, each with an amount to fill in. */
  function addSaved(picked: Beneficiary[]) {
    const fresh = picked.filter((b) => !added.has(b._id)).slice(0, Math.max(0, room))
    if (!fresh.length) return
    setSaved((prev) => [...prev, ...fresh.map((b) => ({ key: `saved:${b._id}`, beneficiary: b, amount: "", narration: "" }))])
  }

  function updateSaved(key: string, patch: Partial<SavedRow>) {
    setSaved((prev) => prev.map((s) => (s.key === key ? { ...s, ...patch } : s)))
    setSavedErrors((prev) => ({ ...prev, [key]: "" }))
    setServerErrors((prev) => ({ ...prev, [key]: "" }))
  }

  /**
   * Shows the names the bank gives now for rows refused with ACCOUNT_NAME_CHANGED, and marks those accounts
   * to be checked again (with the name the member saw before). Saved beneficiaries are paid under their saved
   * names, so only the CSV's accounts can change.
   */
  function markRenamed(list: Entry[], names: Record<string, Checked<ResolvedAccount>>, changes: BulkRowError[]) {
    const found = changes.flatMap((c) => {
      const e = list[c.row]
      return c.code === "ACCOUNT_NAME_CHANGED" && c.accountName && e?.kind === "account" ? [{ row: e.row, accountName: c.accountName }] : []
    })
    if (!found.length) return names
    const next = { ...names }
    const before: Record<string, string> = {}
    for (const c of found) {
      const key = lookupKey(c.row)
      const was = names[key]?.data
      if (!was) continue
      before[key] = renamed[key] ?? was.accountName
      next[key] = { data: { ...was, accountName: c.accountName } }
    }
    setLookups(next)
    setRenamed((prev) => ({ ...before, ...prev }))
    return next
  }

  /**
   * Name enquiries for the CSV's accounts that haven't been checked yet, a slice of rows per call so the progress
   * bar moves (the API runs 5 at a time). Saved beneficiaries need none. The names afterwards, or null if it was
   * stopped or the check failed.
   */
  async function check(list: Row[]) {
    const run = ++checkRun.current
    const pending = new Map<string, { accountNumber: string; bankUuid: string }>()
    for (const r of list) if (!lookups[lookupKey(r)]?.data) pending.set(lookupKey(r), { accountNumber: r.accountNumber, bankUuid: r.bank!.uuid })
    const queue = [...pending.entries()]
    setError(undefined)
    let names = lookups
    if (!queue.length) return names

    let done = 0
    setProgress({ done, total: queue.length })
    try {
      for (let i = 0; i < queue.length; i += BULK_CHECK_SLICE) {
        const slice = queue.slice(i, i + BULK_CHECK_SLICE)
        const result = await resolveAccounts(slice.map(([, row]) => row))
        if (checkRun.current !== run) return null
        if (!result.ok) {
          setError(result.error)
          return null
        }
        names = { ...names, ...Object.fromEntries(slice.map(([key], j) => [key, result.data[j]])) }
        setLookups(names)
        setProgress({ done: (done += slice.length), total: queue.length })
      }
      return names
    } catch {
      if (checkRun.current === run) setError("We couldn't finish checking the accounts. Check your connection and try again.")
      return null
    } finally {
      if (checkRun.current === run) setProgress(null)
    }
  }

  /** The API's dry run for these rows: each fee, the totals, the balance and who would have to approve. */
  async function runPreview(list: Entry[], names: Record<string, Checked<ResolvedAccount>>) {
    const run = checkRun.current
    setPreviewing(true)
    try {
      const result = await previewBulkTransfer({ branch: sourceId, title: title.trim() || undefined, items: apiItems(list, names) })
      if (checkRun.current !== run) return false
      if (!result.ok) {
        setError(result.error)
        return false
      }
      markRenamed(list, names, result.data.errors)
      setPreview({ key: previewKey(sourceId, list), data: result.data })
      return true
    } catch {
      if (checkRun.current === run) setError("We couldn't work out the fees. Check your connection and try again.")
      return false
    } finally {
      setPreviewing(false)
    }
  }

  async function review() {
    const problems: Record<string, string> = {}
    for (const s of saved) {
      const problem = amountProblem(s.amount)
      if (problem) problems[s.key] = problem
    }
    setSavedErrors(problems)
    if (!entries.length || tooMany || rows.some((r) => r.error) || Object.keys(problems).length) return
    setServerErrors({})
    const names = await check(rows)
    if (names && (await runPreview(entries, names))) setStep("review")
  }

  async function checkAgain() {
    setServerErrors({})
    const names = await check(rows)
    if (names) await runPreview(entries, names)
  }

  /** Takes rows out of the transfer (and the CSV text), so the rest can go, and works the totals out again. */
  async function removeRows(drop: Set<string>) {
    const lines = new Set(checked.flatMap((r) => (r.kind === "account" && drop.has(r.key) ? [r.row.line] : [])))
    const nextText = lines.size ? dropLines(text, lines) : text
    const nextSaved = saved.filter((s) => !drop.has(s.key))
    setText(nextText)
    setSaved(nextSaved)
    setServerErrors({})
    const left = toEntries(nextSaved, banks ? parseTransferCsv(nextText, banks) : [])
    if (!left.length) return setStep("details")
    await runPreview(left, lookups)
  }

  const removeFailed = () => removeRows(new Set(checked.filter((r) => r.problem).map((r) => r.key)))
  const removeRenamed = () => removeRows(new Set(checked.filter((r) => r.was !== undefined).map((r) => r.key)))

  async function send() {
    setBusy(true)
    setError(undefined)
    setServerErrors({})
    const request = {
      branch: sourceId,
      title: title.trim() || undefined,
      items: apiItems(entries, lookups),
      saveBeneficiaries: saveAccounts ? (true as const) : undefined,
    }
    // The same rows sent again keep the key, whatever went wrong (a wrong PIN included); editing the rows, the
    // account or "Save new accounts" gets a new one, and so does adding or removing a saved beneficiary. The names
    // are left out, as the API leaves them out of what it compares a repeat with: sending again after checking a
    // changed name replays a batch that already went instead of paying twice.
    const idempotencyKey = idempotency.keyFor({ ...request, items: paidItems(entries) })
    const count = `${entries.length} ${entries.length === 1 ? "transfer" : "transfers"}`
    const result = await pin.confirm({
      purpose: `send ${formatNaira(totalKobo)} to ${peopleCount(entries.length)}`,
      confirmLabel: `Send ${count}`,
      run: (transactionPin) => createBulkTransfer({ ...request, idempotencyKey }, transactionPin),
    })
    setBusy(false)
    if (!result) return
    if (!result.ok) {
      const renamedRows = result.rows?.filter((r) => r.code === "ACCOUNT_NAME_CHANGED" && entries[r.row]?.kind === "account") ?? []
      const others = result.rows?.filter((r) => !renamedRows.includes(r)) ?? []
      markRenamed(entries, lookups, renamedRows)
      if (others.length) {
        setServerErrors(Object.fromEntries(others.flatMap((r) => (entries[r.row] ? [[entries[r.row].key, rowMessage(r.code, r.error)]] : []))))
      }
      // Changed names have their own message above the rows.
      if (!renamedRows.length || others.length) setError(result.error)
      return
    }
    const batch = result.data.batch
    const waiting = batch ? batch.statusCounts.pending_approval > 0 : result.data.items?.[0]?.status === "pending_approval"
    const kept = saveAccounts ? " New accounts are saved to your beneficiaries." : ""
    toast.success(
      waiting
        ? `${count} sent for approval. The money is held until someone approves.${kept}`
        : `${entries.length} ${entries.length === 1 ? "transfer is" : "transfers are"} on the way.${kept}`,
    )
    setOpen(false)
    reset()
  }

  const people = peopleCount(entries.length)
  const them = failed === 1 ? "it" : "them"

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) reset()
      }}
    >
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{step === "details" ? "Bulk transfer" : "Check and send"}</DialogTitle>
          <DialogDescription>
            {step === "details"
              ? `Pay up to ${MAX_ROWS} people from one account, for salaries or suppliers: your saved beneficiaries, a CSV of accounts, or both. We check every new account with its bank before anything is sent.`
              : "Check each name is who you mean to pay. Nothing moves until you confirm."}
          </DialogDescription>
        </DialogHeader>

        <FormError message={error} />

        {step === "details" ? (
          <fieldset disabled={checking} className="grid min-w-0 gap-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="bulk-source">From</FieldLabel>
                <NativeSelect id="bulk-source" value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
                  {accounts.map((a) => (
                    <option key={a._id} value={a.branch._id}>
                      {a.branch.name} · {a.accountNumber}
                    </option>
                  ))}
                </NativeSelect>
                {spendable !== undefined && (
                  <FieldDescription>
                    <span className="figure">{formatNaira(spendable)}</span> available
                  </FieldDescription>
                )}
              </Field>
              <Field>
                <FieldLabel htmlFor="bulk-title">Name (optional)</FieldLabel>
                <Input id="bulk-title" maxLength={80} placeholder="October salaries" value={title} onChange={(e) => setTitle(e.target.value)} />
              </Field>
            </div>

            <Field>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <FieldLabel htmlFor="bulk-csv">Recipients</FieldLabel>
                <div className="flex flex-wrap gap-2">
                  <BeneficiaryPickerDialog purpose="bulk" added={added} room={room} onAdd={addSaved}>
                    <Button type="button" variant="outline" size="sm" disabled={room <= 0}>
                      <BookUser data-icon="inline-start" aria-hidden />
                      Add from beneficiaries
                    </Button>
                  </BeneficiaryPickerDialog>
                  <Button variant="ghost" size="sm" asChild>
                    <a href={csvHref(TRANSFER_CSV_TEMPLATE)} download="linkpay-bulk-transfer.csv">
                      Download template
                    </a>
                  </Button>
                  <Button variant="outline" size="sm" asChild>
                    <label className="cursor-pointer">
                      <FileUp data-icon="inline-start" aria-hidden />
                      Upload CSV
                      <input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => onFile(e.target.files?.[0])} />
                    </label>
                  </Button>
                </div>
              </div>

              {saved.length > 0 && (
                <div className="overflow-hidden rounded-xl border">
                  <div className="border-b bg-muted/60 px-4 py-2.5 text-sm">
                    {peopleCount(saved.length)} from your beneficiaries, <span className="figure font-medium">{formatNaira(savedKobo)}</span> before fees
                  </div>
                  <ul className="max-h-72 divide-y overflow-y-auto">
                    {saved.map((s) => {
                      const problem = savedErrors[s.key] || serverErrors[s.key]
                      const label = s.beneficiary.nickname ?? s.beneficiary.accountName
                      return (
                        <li
                          key={s.key}
                          className={cn(
                            "grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,11rem)_10rem_2.25rem] sm:items-center",
                            problem && "bg-destructive/5",
                          )}
                        >
                          <BeneficiaryName beneficiary={s.beneficiary} />
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="sm:order-last"
                            aria-label={`Remove ${label}`}
                            onClick={() => {
                              setSaved((prev) => prev.filter((x) => x.key !== s.key))
                              setServerErrors((prev) => ({ ...prev, [s.key]: "" }))
                            }}
                          >
                            <X aria-hidden />
                          </Button>
                          <div className="col-span-2 grid gap-2 sm:col-span-2 sm:grid-cols-[minmax(0,11rem)_10rem] sm:gap-3">
                            <Input
                              aria-label={`Narration for ${label}`}
                              maxLength={MAX_NARRATION}
                              placeholder="Narration (optional)"
                              value={s.narration}
                              onChange={(e) => updateSaved(s.key, { narration: e.target.value })}
                            />
                            <div className="grid gap-1">
                              <NairaInput
                                aria-label={`Amount for ${label}`}
                                value={s.amount}
                                invalid={!!problem}
                                className="text-right"
                                onChange={(amount) => updateSaved(s.key, { amount })}
                              />
                              {problem && <span className="text-xs text-destructive">{problem}</span>}
                            </div>
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )}

              <Textarea
                id="bulk-csv"
                rows={5}
                spellCheck={false}
                className="font-mono text-xs"
                placeholder={"account_number,bank,amount,narration\n0123456789,Access Bank,25000,October salary"}
                value={text}
                onChange={(e) => {
                  setText(e.target.value)
                  setServerErrors({})
                }}
              />
              <FieldDescription>One account per line: account number, bank name or code, amount in naira, then an optional narration.</FieldDescription>
            </Field>

            {rows.length > 0 && (
              <div className="overflow-hidden rounded-xl border">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/60 px-4 py-2.5 text-sm">
                  <span>
                    {peopleCount(rows.length)} from the CSV, <span className="figure font-medium">{formatNaira(csvKobo)}</span> before fees
                  </span>
                  {invalid > 0 && (
                    <span className="text-destructive">
                      {invalid} {invalid === 1 ? "row needs" : "rows need"} fixing
                    </span>
                  )}
                </div>
                <div className="max-h-72 overflow-y-auto">
                  <table className="w-full text-sm">
                    <caption className="sr-only">Bulk transfer rows from the CSV</caption>
                    <thead className="text-xs text-muted-foreground">
                      <tr className="border-b">
                        <th scope="col" className="px-4 py-2 text-left font-medium">Line</th>
                        <th scope="col" className="px-2 py-2 text-left font-medium">Account</th>
                        <th scope="col" className="px-2 py-2 text-left font-medium">Bank</th>
                        <th scope="col" className="px-4 py-2 text-right font-medium">Amount</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {rows.map((r) => {
                        const problem = r.error ?? (serverErrors[`line:${r.line}`] || undefined)
                        return (
                          <tr key={r.line} className={cn(problem && "bg-destructive/5")}>
                            <td className="px-4 py-2 align-top text-muted-foreground figure">{r.line}</td>
                            <td className="px-2 py-2 align-top">
                              <span className="font-mono">{r.accountNumber || "Missing"}</span>
                              {problem && <span className="block text-xs text-destructive">{problem}</span>}
                              {!problem && r.narration && <span className="block text-xs text-muted-foreground">{r.narration}</span>}
                            </td>
                            <td className="px-2 py-2 align-top">{r.bank?.name ?? r.bankText}</td>
                            <td className="px-4 py-2 text-right align-top figure">{r.amountKobo !== null ? formatNaira(r.amountKobo) : "Invalid"}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {rows.length > 0 && (
              <Field orientation="horizontal">
                <Checkbox id="bulk-save" checked={saveNew} onCheckedChange={(v) => setSaveNew(v === true)} />
                <FieldContent>
                  <FieldLabel htmlFor="bulk-save" className="font-normal">
                    Save new accounts to beneficiaries
                  </FieldLabel>
                  <FieldDescription>
                    The CSV&apos;s accounts are saved with the names their banks give, so anyone on your team can pay them again without a CSV.
                  </FieldDescription>
                </FieldContent>
              </Field>
            )}

            {saved.length > 0 && rows.length > 0 && (
              <p className="text-sm">
                Altogether {people}, <span className="figure font-medium">{formatNaira(totalKobo)}</span> before fees.
              </p>
            )}
            {tooMany && (
              <p className="text-sm text-destructive">
                That&apos;s {people}. One bulk transfer can pay up to {MAX_ROWS}, so split them into more than one.
              </p>
            )}
          </fieldset>
        ) : (
          <div className="grid gap-4">
            <dl className="divide-y rounded-xl border text-sm">
              <ReviewRow label="From" value={`${source?.branch.name} · ${source?.accountNumber}`} />
              {title.trim() && <ReviewRow label="Name" value={title.trim()} />}
              <ReviewRow
                label="Amount"
                value={
                  <span className="grid justify-items-end">
                    <span className="figure">{formatNaira(totalKobo)}</span>
                    <span className="text-xs text-muted-foreground">to {people}</span>
                  </span>
                }
              />
              <ReviewRow
                label="Fees"
                value={
                  current ? (
                    <span className="grid justify-items-end">
                      <span className="figure">{formatNaira(current.feeKobo)}</span>
                      {current.stampDutyKobo > 0 && (
                        <span className="text-xs text-muted-foreground">
                          includes <span className="figure">{formatNaira(current.stampDutyKobo)}</span> stamp duty
                        </span>
                      )}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">Working out</span>
                  )
                }
              />
              <ReviewRow
                label="Total from the account"
                value={<span className="type-display text-xl figure">{current ? formatNaira(current.totalKobo) : "…"}</span>}
              />
              {current && (
                <ReviewRow
                  label="Approval"
                  value={
                    <span className="grid justify-items-end text-right">
                      <span className="font-medium">{approvalLine(current.approval)}</span>
                      {current.approval.needed && current.approval.earlierKobo > 0 && (
                        <span className="text-xs text-muted-foreground">
                          Counts the <span className="figure">{formatNaira(current.approval.earlierKobo)}</span> you&apos;ve sent from {current.branch.name}{" "}
                          in the last 24 hours
                        </span>
                      )}
                      {current.approval.needed && <span className="text-xs text-muted-foreground">The money is held until it&apos;s approved</span>}
                    </span>
                  }
                />
              )}
            </dl>

            {saveAccounts && <p className="text-sm text-muted-foreground">The CSV&apos;s new accounts will be saved to your beneficiaries when you send.</p>}

            {short && (
              <p className="text-sm text-destructive">
                With {formatNaira(current!.feeKobo)} in fees this needs {formatNaira(current!.totalKobo)}. {source?.branch.name} has{" "}
                {formatNaira(available ?? 0)} available.
              </p>
            )}
            {blockers.map((b) => (
              <p key={b.code ?? b.error} className="text-sm text-destructive">
                {b.error}
              </p>
            ))}

            {changed > 0 && (
              <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-warning-subtle px-3 py-2.5 text-sm">
                <p className="text-warning-foreground">
                  The bank now gives a different name for {changedAccounts === 1 ? "1 account" : `${changedAccounts} accounts`}. Check the
                  highlighted {changed === 1 ? "row is" : "rows are"} who you mean to pay before sending.
                </p>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => setRenamed({})} disabled={busy || checking}>
                    The new {changedAccounts === 1 ? "name is" : "names are"} right
                  </Button>
                  <Button variant="outline" size="sm" onClick={removeRenamed} disabled={busy || checking}>
                    Remove {changed === 1 ? "it" : "them"}
                  </Button>
                </div>
              </div>
            )}

            {failed > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-destructive-subtle px-3 py-2.5 text-sm">
                <p className="text-destructive">
                  {failed} {failed === 1 ? "row needs" : "rows need"} fixing before anything can be sent. Go back and fix {them}, or remove {them} from this transfer.
                </p>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={checkAgain} disabled={busy || checking}>
                    Check again
                  </Button>
                  <Button variant="outline" size="sm" onClick={removeFailed} disabled={busy || checking}>
                    Remove {them}
                  </Button>
                </div>
              </div>
            )}

            <div className="overflow-hidden rounded-xl border">
              <div className="max-h-80 overflow-y-auto">
                <table className="w-full text-sm">
                  <caption className="sr-only">Each transfer, with the account name and the fee</caption>
                  <thead className="text-xs text-muted-foreground">
                    <tr className="border-b">
                      <th scope="col" className="px-4 py-2 text-left font-medium">Line</th>
                      <th scope="col" className="px-2 py-2 text-left font-medium">To</th>
                      <th scope="col" className="px-2 py-2 text-right font-medium">Amount</th>
                      <th scope="col" className="px-4 py-2 text-right font-medium">Fee</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {checked.map((r) => (
                      <tr key={r.key} className={cn(r.problem ? "bg-destructive/5" : r.was !== undefined && "bg-warning-subtle/60")}>
                        <td className="px-4 py-2 align-top text-muted-foreground figure">
                          {r.kind === "account" ? r.row.line : <BookUser className="mt-0.5 size-4" aria-label="Saved beneficiary" />}
                        </td>
                        <td className="px-2 py-2 align-top">
                          {r.kind === "saved" ? (
                            <BeneficiaryName beneficiary={r.saved.beneficiary} />
                          ) : (
                            <>
                              {r.account && <ResolvedName account={r.account} />}
                              <span className="block text-xs text-muted-foreground">
                                {r.row.bank?.name ?? r.row.bankText} · <span className="font-mono">{r.row.accountNumber}</span>
                              </span>
                            </>
                          )}
                          {r.problem ? (
                            <span className="block text-xs text-destructive">{r.problem}</span>
                          ) : r.was !== undefined ? (
                            <span className="block text-xs text-warning-foreground">
                              The bank&apos;s name for this account has changed. You checked “{r.was}”.
                            </span>
                          ) : (
                            r.narration && <span className="block text-xs text-muted-foreground">{r.narration}</span>
                          )}
                        </td>
                        <td className="px-2 py-2 text-right align-top figure">{r.amountKobo !== null && formatNaira(r.amountKobo)}</td>
                        <td className="px-4 py-2 text-right align-top figure">{r.fee && formatNaira(r.fee.feeKobo)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {previewing && !progress && (
          <p role="status" className="inline-flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Working out the fees and who needs to approve
          </p>
        )}
        {progress && (
          <div role="status" className="grid gap-2 text-sm">
            <div className="flex items-center justify-between gap-2 text-muted-foreground">
              <span className="inline-flex items-center gap-2">
                <Spinner /> Checking accounts with their banks
              </span>
              <span className="figure">
                {progress.done} of {progress.total}
              </span>
            </div>
            <Progress value={(progress.done / progress.total) * 100} aria-label="Checking accounts" />
          </div>
        )}

        <DialogFooter>
          {step === "details" ? (
            <>
              <Button variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button onClick={review} disabled={checking || waitingForBanks || entries.length === 0 || rows.some((r) => r.error) || tooMany}>
                {checking && <Spinner />}
                Continue
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => setStep("details")} disabled={busy || checking}>
                Back
              </Button>
              <Button onClick={send} disabled={busy || checking || !current || failed > 0 || changed > 0 || !!short || blockers.length > 0}>
                {busy ? <Spinner /> : <Send data-icon="inline-start" aria-hidden />}
                {busy ? "Sending" : `Send ${entries.length} ${entries.length === 1 ? "transfer" : "transfers"}`}
              </Button>
            </>
          )}
        </DialogFooter>
        {pin.dialog}
      </DialogContent>
    </Dialog>
  )
}
