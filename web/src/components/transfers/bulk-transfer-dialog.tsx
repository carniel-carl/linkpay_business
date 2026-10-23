"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { FileUp, Send } from "lucide-react"
import { toast } from "sonner"
import { createBulkTransfer, listBanks, quoteFees, resolveAccounts } from "@/app/(dashboard)/transfers/actions"
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
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { NativeSelect } from "@/components/ui/native-select"
import { Progress } from "@/components/ui/progress"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { useIdempotencyKey } from "@/hooks/use-idempotency-key"
import type { Bank, FeeQuote, ResolvedAccount } from "@/lib/api/types"
import { formatNaira } from "@/lib/format"
import { BULK_CHECK_SLICE, MAX_TRANSFER_KOBO, parseNairaToKobo } from "@/lib/transfers"
import { cn } from "@/lib/utils"
import { ResolvedName, ReviewRow, type SourceAccount } from "./new-transfer-dialog"

const MAX_ROWS = 200
const TEMPLATE = "account_number,bank,amount,narration\n0123456789,Access Bank,25000,October salary\n"

type Row = {
  line: number
  accountNumber: string
  bankText: string
  bank?: Bank
  amountKobo: number | null
  narration?: string
  error?: string
}

/** A name enquiry or fee quote: the answer, or why it failed. */
type Checked<T> = { data?: T; error?: string }

const norm = (s: string) => s.toLowerCase().replace(/\b(plc|limited|ltd|bank|of|nigeria|the)\b/g, "").replace(/[^a-z0-9]/g, "")

/** "Bank:account number", the key a name enquiry is kept under. */
const lookupKey = (r: Row) => `${r.bank?.uuid}:${r.accountNumber}`

/** Splits one CSV line, honouring double quotes ("Lagos, Ikeja"). */
function splitCsvLine(line: string) {
  const cells: string[] = []
  let cell = ""
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cell += '"'
        i++
      } else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === ",") {
      cells.push(cell.trim())
      cell = ""
    } else cell += ch
  }
  cells.push(cell.trim())
  return cells
}

const bankLabel = (b: Bank) => (b.code ? `${b.name} (${b.code})` : b.name)

/**
 * The bank a row names. An exact name or code (any case) wins. Failing that, the start of a bank's name, then
 * the name ignoring words like "Bank" and "Plc" (in full or its start). The first of these that fits any bank
 * has to fit exactly one: text that fits more than one bank is refused with the banks it could be, never guessed.
 */
function findBank(banks: Bank[], text: string): { bank?: Bank; error?: string } {
  const t = text.trim()
  if (!t) return { error: "Add the bank." }
  const lower = t.toLowerCase()
  const n = norm(t)
  const tiers = [
    banks.filter((b) => b.name.toLowerCase() === lower || b.code?.toLowerCase() === lower),
    lower.length >= 3 ? banks.filter((b) => b.name.toLowerCase().startsWith(lower)) : [],
    n ? banks.filter((b) => norm(b.name) === n || (n.length >= 3 && norm(b.name).startsWith(n))) : [],
  ]
  const matches = tiers.find((m) => m.length > 0) ?? []
  if (matches.length === 1) return { bank: matches[0] }
  if (!matches.length) return { error: `We don't know the bank “${t}”.` }
  const shown = matches.slice(0, 3).map(bankLabel).join(", ")
  const more = matches.length > 3 ? ` and ${matches.length - 3} more` : ""
  return {
    error: `“${t}” matches more than one bank: ${shown}${more}. Use the full name${matches.some((b) => b.code) ? " or the bank code" : ""}.`,
  }
}

/** Rows from CSV text: account number, bank (name or code), amount in naira, optional narration. */
function parseRows(text: string, banks: Bank[]): Row[] {
  const lines = text.split(/\r?\n/).map((l, i) => ({ text: l.trim(), line: i + 1 })).filter((l) => l.text)
  // A header row is optional.
  if (lines[0] && /account/i.test(lines[0].text) && !/\d{10}/.test(lines[0].text)) lines.shift()
  return lines.map(({ text, line }) => {
    const [accountNumber = "", bankText = "", amount = "", ...rest] = splitCsvLine(text)
    const narration = rest.join(", ").trim().slice(0, 100) || undefined
    const match = findBank(banks, bankText)
    const amountKobo = parseNairaToKobo(amount)
    const digits = accountNumber.replace(/\D/g, "")
    let error: string | undefined
    if (!/^\d{10}$/.test(digits)) error = "Account numbers are 10 digits."
    else if (match.error) error = match.error
    else if (amountKobo === null || amountKobo < 100) error = "Enter an amount of at least ₦1."
    else if (amountKobo > MAX_TRANSFER_KOBO) error = `One transfer can be at most ${formatNaira(MAX_TRANSFER_KOBO)}.`
    return { line, accountNumber: digits, bankText, bank: match.bank, amountKobo, narration, error }
  })
}

/**
 * Pay many people from one account: upload or paste a CSV, then check every account name and fee in a review
 * before sending it for approval or straight away.
 */
export function BulkTransferDialog({ accounts, defaultBranchId, children }: { accounts: SourceAccount[]; defaultBranchId?: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState<"details" | "review">("details")
  const [banks, setBanks] = useState<Bank[] | null>(null)
  const [sourceId, setSourceId] = useState(defaultBranchId ?? accounts[0]?.branch._id ?? "")
  const [title, setTitle] = useState("")
  const [text, setText] = useState("")
  // Name enquiries by bank and account number, and fees by amount. Kept while the dialog is open, so going
  // back to fix a row only checks what changed; failed checks are tried again.
  const [lookups, setLookups] = useState<Record<string, Checked<ResolvedAccount>>>({})
  const [fees, setFees] = useState<Record<number, Checked<FeeQuote>>>({})
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [serverErrors, setServerErrors] = useState<Record<number, string>>({})
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const idempotency = useIdempotencyKey()
  // Bumped to stop a check that's running (the dialog closed, or a newer check started).
  const checkRun = useRef(0)

  useEffect(() => {
    if (!open || banks) return
    listBanks().then((r) => (r.ok ? setBanks(r.data) : setError(r.error)))
  }, [open, banks])

  const rows = useMemo(() => (banks ? parseRows(text, banks) : []), [text, banks])
  const source = accounts.find((a) => a.branch._id === sourceId)
  const totalKobo = rows.reduce((s, r) => s + (r.amountKobo ?? 0), 0)
  const invalid = rows.filter((r, i) => r.error || serverErrors[i]).length
  const tooMany = rows.length > MAX_ROWS
  const spendable = source?.balance?.availableKobo ?? source?.balance?.amountKobo
  const checking = progress !== null

  // The review: each row with its account name and fee, and what stops it being sent.
  const checked = rows.map((r, i) => {
    const lookup = lookups[lookupKey(r)]
    const fee = r.amountKobo !== null ? fees[r.amountKobo] : undefined
    const problem = r.error ?? serverErrors[i] ?? lookup?.error ?? fee?.error ?? (!lookup?.data || !fee?.data ? "Not checked yet." : undefined)
    return { ...r, account: lookup?.data, fee: fee?.data, problem }
  })
  const failed = checked.filter((r) => r.problem).length
  const feeKobo = checked.reduce((s, r) => s + (r.fee?.feeKobo ?? 0), 0)
  const stampDutyKobo = checked.reduce((s, r) => s + (r.fee?.stampDutyKobo ?? 0), 0)
  const grandTotalKobo = totalKobo + feeKobo
  const short = spendable !== undefined && grandTotalKobo > spendable

  function reset() {
    checkRun.current++
    setStep("details")
    setText("")
    setTitle("")
    setLookups({})
    setFees({})
    setProgress(null)
    setServerErrors({})
    setError(undefined)
    idempotency.reset()
  }

  async function onFile(file?: File) {
    if (!file) return
    if (file.size > 512 * 1024) return setError("That file is too big. Keep it under 500 KB (about 200 rows).")
    setServerErrors({})
    setText(await file.text())
  }

  /**
   * Name enquiries for the accounts, and fees for the amounts, that haven't been checked yet. A slice at a time
   * (the server runs 5 at once), so the progress bar moves. False if it was stopped or the check itself failed.
   */
  async function check(list: Row[]) {
    const run = ++checkRun.current
    const pending = new Map<string, { accountNumber: string; bankUuid: string }>()
    for (const r of list) if (!lookups[lookupKey(r)]?.data) pending.set(lookupKey(r), { accountNumber: r.accountNumber, bankUuid: r.bank!.uuid })
    const queue = [...pending.entries()]
    const amounts = [...new Set(list.map((r) => r.amountKobo!))].filter((a) => !fees[a]?.data)
    const total = queue.length + amounts.length
    setError(undefined)
    if (!total) return true

    let done = 0
    setProgress({ done, total })
    try {
      for (let i = 0; i < queue.length; i += BULK_CHECK_SLICE) {
        const slice = queue.slice(i, i + BULK_CHECK_SLICE)
        const result = await resolveAccounts(slice.map(([, row]) => row))
        if (checkRun.current !== run) return false
        if (!result.ok) {
          setError(result.error)
          return false
        }
        setLookups((prev) => ({ ...prev, ...Object.fromEntries(slice.map(([key], j) => [key, result.data[j]])) }))
        setProgress({ done: (done += slice.length), total })
      }
      for (let i = 0; i < amounts.length; i += BULK_CHECK_SLICE) {
        const slice = amounts.slice(i, i + BULK_CHECK_SLICE)
        const result = await quoteFees(slice)
        if (checkRun.current !== run) return false
        if (!result.ok) {
          setError(result.error)
          return false
        }
        setFees((prev) => ({ ...prev, ...Object.fromEntries(slice.map((kobo, j) => [kobo, result.data[j]])) }))
        setProgress({ done: (done += slice.length), total })
      }
      return true
    } catch {
      if (checkRun.current === run) setError("We couldn't finish checking the accounts. Check your connection and try again.")
      return false
    } finally {
      if (checkRun.current === run) setProgress(null)
    }
  }

  async function review() {
    if (!rows.length || tooMany || rows.some((r) => r.error)) return
    setServerErrors({})
    if (await check(rows)) setStep("review")
  }

  async function checkAgain() {
    setServerErrors({})
    await check(rows)
  }

  /** Takes the rows that can't be sent out of the list (and the CSV text), so the rest can go. */
  function removeFailed() {
    const drop = new Set(checked.filter((r) => r.problem).map((r) => r.line))
    setText(text.split(/\r?\n/).filter((_, i) => !drop.has(i + 1)).join("\n"))
    setServerErrors({})
    if (drop.size >= rows.length) setStep("details")
  }

  async function send() {
    setBusy(true)
    setError(undefined)
    setServerErrors({})
    const request = {
      branch: sourceId,
      title: title.trim() || undefined,
      items: rows.map((r) => ({ accountNumber: r.accountNumber, bankUuid: r.bank!.uuid, amountKobo: r.amountKobo!, narration: r.narration })),
    }
    // The same rows sent again keep the key, whatever went wrong; editing the list or the account gets a new one.
    const result = await createBulkTransfer({ ...request, idempotencyKey: idempotency.keyFor(request) })
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      if (result.rows) setServerErrors(Object.fromEntries(result.rows.map((r) => [r.row, r.error])))
      return
    }
    const batch = result.data.batch
    const waiting = batch ? batch.statusCounts.pending_approval > 0 : result.data.items?.[0]?.status === "pending_approval"
    toast.success(
      waiting
        ? `${rows.length} ${rows.length === 1 ? "transfer" : "transfers"} sent for approval. The money is held until someone approves.`
        : `${rows.length} ${rows.length === 1 ? "transfer is" : "transfers are"} on the way.`,
    )
    setOpen(false)
    reset()
  }

  const people = `${rows.length} ${rows.length === 1 ? "person" : "people"}`
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
              ? `Pay up to ${MAX_ROWS} people from one account, for salaries or suppliers. We check every account with its bank before anything is sent.`
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
                <div className="flex gap-2">
                  <Button variant="ghost" size="sm" asChild>
                    <a href={`data:text/csv;charset=utf-8,${encodeURIComponent(TEMPLATE)}`} download="linkpay-bulk-transfer.csv">
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
              <FieldDescription>One person per line: account number, bank name or code, amount in naira, then an optional narration.</FieldDescription>
            </Field>

            {rows.length > 0 && (
              <div className="overflow-hidden rounded-xl border">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/60 px-4 py-2.5 text-sm">
                  <span>
                    {people}, <span className="figure font-medium">{formatNaira(totalKobo)}</span> before fees
                  </span>
                  {invalid > 0 && (
                    <span className="text-destructive">
                      {invalid} {invalid === 1 ? "row needs" : "rows need"} fixing
                    </span>
                  )}
                </div>
                <div className="max-h-72 overflow-y-auto">
                  <table className="w-full text-sm">
                    <caption className="sr-only">Bulk transfer rows</caption>
                    <thead className="text-xs text-muted-foreground">
                      <tr className="border-b">
                        <th scope="col" className="px-4 py-2 text-left font-medium">Line</th>
                        <th scope="col" className="px-2 py-2 text-left font-medium">Account</th>
                        <th scope="col" className="px-2 py-2 text-left font-medium">Bank</th>
                        <th scope="col" className="px-4 py-2 text-right font-medium">Amount</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {rows.map((r, i) => {
                        const problem = r.error ?? serverErrors[i]
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
            {tooMany && <p className="text-sm text-destructive">That&apos;s {rows.length} rows. Split it into files of {MAX_ROWS} or fewer.</p>}
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
                  <span className="grid justify-items-end">
                    <span className="figure">{formatNaira(feeKobo)}</span>
                    {stampDutyKobo > 0 && (
                      <span className="text-xs text-muted-foreground">
                        includes <span className="figure">{formatNaira(stampDutyKobo)}</span> stamp duty
                      </span>
                    )}
                  </span>
                }
              />
              <ReviewRow label="Total from the account" value={<span className="type-display text-xl figure">{formatNaira(grandTotalKobo)}</span>} />
            </dl>

            {short && (
              <p className="text-sm text-destructive">
                With {formatNaira(feeKobo)} in fees this needs {formatNaira(grandTotalKobo)}. {source!.branch.name} has {formatNaira(spendable!)} available.
              </p>
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
                  <caption className="sr-only">Each transfer, with the account name from the bank and the fee</caption>
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
                      <tr key={r.line} className={cn(r.problem && "bg-destructive/5")}>
                        <td className="px-4 py-2 align-top text-muted-foreground figure">{r.line}</td>
                        <td className="px-2 py-2 align-top">
                          {r.account && <ResolvedName account={r.account} />}
                          <span className="block text-xs text-muted-foreground">
                            {r.bank?.name ?? r.bankText} · <span className="font-mono">{r.accountNumber}</span>
                          </span>
                          {r.problem ? (
                            <span className="block text-xs text-destructive">{r.problem}</span>
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
              <Button onClick={review} disabled={checking || !banks || rows.length === 0 || rows.some((r) => r.error) || tooMany}>
                {checking && <Spinner />}
                Continue
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => setStep("details")} disabled={busy || checking}>
                Back
              </Button>
              <Button onClick={send} disabled={busy || checking || failed > 0 || short}>
                {busy ? <Spinner /> : <Send data-icon="inline-start" aria-hidden />}
                {busy ? "Sending" : `Send ${rows.length} ${rows.length === 1 ? "transfer" : "transfers"}`}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
