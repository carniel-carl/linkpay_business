"use client"

import { useEffect, useMemo, useState } from "react"
import { FileUp, Send } from "lucide-react"
import { toast } from "sonner"
import { createBulkTransfer, listBanks } from "@/app/(dashboard)/transfers/actions"
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
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import type { Bank } from "@/lib/api/types"
import { formatNaira } from "@/lib/format"
import { parseNairaToKobo } from "@/lib/transfers"
import { cn } from "@/lib/utils"
import type { SourceAccount } from "./new-transfer-dialog"

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

const newKey = () => crypto.randomUUID().replaceAll("-", "")
const norm = (s: string) => s.toLowerCase().replace(/\b(plc|limited|ltd|bank|of|nigeria|the)\b/g, "").replace(/[^a-z0-9]/g, "")

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

function findBank(banks: Bank[], text: string) {
  const t = text.trim()
  if (!t) return undefined
  return (
    banks.find((b) => b.code && b.code === t) ??
    banks.find((b) => b.name.toLowerCase() === t.toLowerCase()) ??
    banks.find((b) => norm(b.name) === norm(t)) ??
    banks.find((b) => norm(t).length >= 3 && norm(b.name).startsWith(norm(t)))
  )
}

/** Rows from CSV text: account number, bank (name or code), amount in naira, optional narration. */
function parseRows(text: string, banks: Bank[]): Row[] {
  const lines = text.split(/\r?\n/).map((l, i) => ({ text: l.trim(), line: i + 1 })).filter((l) => l.text)
  // A header row is optional.
  if (lines[0] && /account/i.test(lines[0].text) && !/\d{10}/.test(lines[0].text)) lines.shift()
  return lines.map(({ text, line }) => {
    const [accountNumber = "", bankText = "", amount = "", ...rest] = splitCsvLine(text)
    const narration = rest.join(", ").trim().slice(0, 100) || undefined
    const bank = findBank(banks, bankText)
    const amountKobo = parseNairaToKobo(amount)
    const digits = accountNumber.replace(/\D/g, "")
    let error: string | undefined
    if (!/^\d{10}$/.test(digits)) error = "Account numbers are 10 digits."
    else if (!bank) error = bankText ? `We don't know the bank “${bankText}”.` : "Add the bank."
    else if (amountKobo === null || amountKobo < 100) error = "Enter an amount of at least ₦1."
    return { line, accountNumber: digits, bankText, bank, amountKobo, narration, error }
  })
}

/** Pay many people from one account: upload or paste a CSV, check it, then send it for approval or straight away. */
export function BulkTransferDialog({ accounts, defaultBranchId, children }: { accounts: SourceAccount[]; defaultBranchId?: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const [banks, setBanks] = useState<Bank[] | null>(null)
  const [sourceId, setSourceId] = useState(defaultBranchId ?? accounts[0]?.branch._id ?? "")
  const [title, setTitle] = useState("")
  const [text, setText] = useState("")
  const [serverErrors, setServerErrors] = useState<Record<number, string>>({})
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [key, setKey] = useState(newKey)

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

  function reset() {
    setText("")
    setTitle("")
    setServerErrors({})
    setError(undefined)
    setKey(newKey())
  }

  async function onFile(file?: File) {
    if (!file) return
    if (file.size > 512 * 1024) return setError("That file is too big. Keep it under 500 KB (about 200 rows).")
    setServerErrors({})
    setText(await file.text())
  }

  async function send() {
    setBusy(true)
    setError(undefined)
    setServerErrors({})
    const result = await createBulkTransfer({
      branch: sourceId,
      title: title.trim() || undefined,
      items: rows.map((r) => ({ accountNumber: r.accountNumber, bankUuid: r.bank!.uuid, amountKobo: r.amountKobo!, narration: r.narration })),
      idempotencyKey: key,
    })
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      if (result.rows) setServerErrors(Object.fromEntries(result.rows.map((r) => [r.row, r.error])))
      if (result.code && result.code !== "ACCOUNT_BUSY") setKey(newKey())
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
          <DialogTitle>Bulk transfer</DialogTitle>
          <DialogDescription>
            Pay up to {MAX_ROWS} people from one account, for salaries or suppliers. We check every account with its bank before anything is sent.
          </DialogDescription>
        </DialogHeader>

        <FormError message={error} />

        <div className="grid gap-5">
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
                  {rows.length} {rows.length === 1 ? "person" : "people"}, <span className="figure font-medium">{formatNaira(totalKobo)}</span> before fees
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
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={send} disabled={busy || !banks || rows.length === 0 || invalid > 0 || tooMany}>
            {busy ? <Spinner /> : <Send data-icon="inline-start" aria-hidden />}
            {busy ? "Checking accounts" : `Send ${rows.length || ""} ${rows.length === 1 ? "transfer" : "transfers"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
