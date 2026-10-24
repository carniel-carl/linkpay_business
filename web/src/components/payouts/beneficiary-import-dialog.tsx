"use client"

import { useEffect, useMemo, useState } from "react"
import { FileUp, RotateCw, Upload } from "lucide-react"
import { importBeneficiaries } from "@/app/(dashboard)/beneficiaries/actions"
import { listBanks } from "@/app/(dashboard)/transfers/actions"
import { FormError } from "@/components/common/form-error"
import { Badge } from "@/components/ui/badge"
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
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import type { Bank, Beneficiary } from "@/lib/api/types"
import {
  BENEFICIARY_CSV_TEMPLATE,
  csvHref,
  MAX_CSV_BYTES,
  MAX_CSV_ROWS,
  parseBeneficiaryCsv,
  type BeneficiaryCsvRow,
} from "@/lib/bulk-csv"
import { cn } from "@/lib/utils"
import { BeneficiaryName } from "./parts"

type Item = { accountNumber: string; bankUuid: string; nickname?: string }

/** What happened to one line of the CSV. */
type Outcome =
  | { status: "saved" | "existing"; beneficiary: Beneficiary }
  | { status: "own" | "failed"; error: string; code?: string | null }
  /** Refused before sending: the line itself has a problem. */
  | { status: "left_out"; error: string }

type ResultRow = { line: number; accountNumber: string; bank: string; item?: Item; outcome: Outcome }

const STATUS: Record<Outcome["status"], { label: string; variant: React.ComponentProps<typeof Badge>["variant"] }> = {
  saved: { label: "Saved", variant: "success" },
  existing: { label: "Already saved", variant: "muted" },
  own: { label: "Your own account", variant: "warning" },
  failed: { label: "Not saved", variant: "destructive" },
  left_out: { label: "Left out", variant: "muted" },
}

const accounts = (n: number) => `${n} ${n === 1 ? "account" : "accounts"}`

/** A line the API's answer left out (not expected, but never shown as saved). */
const NO_ANSWER = "NO_ANSWER"

/**
 * Row codes worth sending again: the bank couldn't answer just then. During an outage the API stops asking after a
 * few of these in a row and returns the rest with the same code, so "Check again" covers them all.
 */
const RETRYABLE = new Set(["NAME_CHECK_UNAVAILABLE", NO_ANSWER])

/**
 * Save many beneficiaries at once from a CSV (account number, bank, optional nickname), pasted or uploaded: a
 * preview of the lines first, using the same bank matching as bulk transfers, then each account is checked with
 * its bank and saved, and every line shows what happened. Good lines are saved even when others fail. It moves
 * no money, so it takes no PIN.
 */
export function BeneficiaryImportDialog({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const [banks, setBanks] = useState<Bank[] | null>(null)
  const [text, setText] = useState("")
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<ResultRow[] | null>(null)

  useEffect(() => {
    if (!open || banks) return
    listBanks().then((r) => (r.ok ? setBanks(r.data) : setError(r.error)))
  }, [open, banks])

  const rows = useMemo(() => (banks ? parseBeneficiaryCsv(text, banks) : []), [text, banks])
  const ready = rows.filter((r) => !r.error)
  const problems = rows.length - ready.length
  const tooMany = rows.length > MAX_CSV_ROWS

  function reset() {
    setText("")
    setError(undefined)
    setResults(null)
  }

  function close() {
    setOpen(false)
    reset()
  }

  async function onFile(file?: File) {
    if (!file) return
    if (file.size > MAX_CSV_BYTES) return setError("That file is too big. Keep it under 500 KB (about 200 rows).")
    setError(undefined)
    setText(await file.text())
  }

  /** Sends the lines to be checked and saved; the answers by line. Null if nothing was saved (the error shows). */
  async function send(lines: { line: number; item: Item }[]) {
    setBusy(true)
    setError(undefined)
    try {
      const result = await importBeneficiaries(lines.map((l) => l.item))
      if (!result.ok) {
        setError(result.error)
        return null
      }
      const byLine = new Map<number, Outcome>()
      for (const r of result.data.rows) {
        const line = lines[r.row]?.line
        if (line === undefined) continue
        byLine.set(
          line,
          "error" in r
            ? { status: r.code === "BENEFICIARY_OWN_ACCOUNT" ? "own" : "failed", error: r.error, code: r.code }
            : { status: r.created ? "saved" : "existing", beneficiary: r.beneficiary },
        )
      }
      return byLine
    } catch {
      setError("We couldn't finish the import. Check your connection, then look at Beneficiaries before trying again.")
      return null
    } finally {
      setBusy(false)
    }
  }

  const label = (r: BeneficiaryCsvRow) => r.bank?.name ?? r.bankText

  async function start() {
    if (!ready.length || tooMany) return
    const lines = ready.map((r) => ({ line: r.line, item: { accountNumber: r.accountNumber, bankUuid: r.bank!.uuid, nickname: r.nickname } }))
    const byLine = await send(lines)
    if (!byLine) return
    setResults(
      rows.map((r): ResultRow => {
        const item = lines.find((l) => l.line === r.line)?.item
        const outcome: Outcome = r.error
          ? { status: "left_out", error: r.error }
          : (byLine.get(r.line) ?? { status: "failed", error: "We didn't get an answer for this line. Check it again.", code: NO_ANSWER })
        return { line: r.line, accountNumber: r.accountNumber, bank: label(r), item, outcome }
      }),
    )
  }

  /** Sends the lines the bank couldn't check just then again, and updates their answers. */
  async function retry() {
    if (!results) return
    const lines = results.flatMap((r) => (retryable(r) && r.item ? [{ line: r.line, item: r.item }] : []))
    if (!lines.length) return
    const byLine = await send(lines)
    if (!byLine) return
    setResults(results.map((r) => (byLine.has(r.line) ? { ...r, outcome: byLine.get(r.line)! } : r)))
  }

  const count = (status: Outcome["status"]) => results?.filter((r) => r.outcome.status === status).length ?? 0
  const retryable = (r: ResultRow) => r.outcome.status === "failed" && RETRYABLE.has(r.outcome.code ?? "")
  const again = results?.filter(retryable).length ?? 0

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // The answer must reach the screen once the accounts are being saved.
        if (busy) return
        setOpen(next)
        if (!next) reset()
      }}
    >
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>{results ? "Import finished" : "Import beneficiaries"}</DialogTitle>
          <DialogDescription>
            {results
              ? [
                  `${count("saved")} saved`,
                  count("existing") ? `${count("existing")} already saved` : null,
                  count("own") ? `${count("own")} your own ${count("own") === 1 ? "account" : "accounts"}` : null,
                  count("failed") ? `${count("failed")} not saved` : null,
                  count("left_out") ? `${count("left_out")} left out` : null,
                ]
                  .filter(Boolean)
                  .join(", ") + "."
              : `Save up to ${MAX_CSV_ROWS} accounts at once from a CSV. We check each one with its bank and save the name it gives, for your whole team.`}
          </DialogDescription>
        </DialogHeader>

        <FormError message={error} />

        {results && again > 0 && !busy && (
          <p className="text-sm text-muted-foreground">
            The bank couldn&apos;t check {accounts(again)} just then, so {again === 1 ? "it isn't" : "they aren't"} saved yet. Check{" "}
            {again === 1 ? "it" : "them"} again in a few minutes.
          </p>
        )}

        {results ? (
          <div className="overflow-hidden rounded-xl border">
            <div className="max-h-96 overflow-y-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">What happened to each line</caption>
                <thead className="text-xs text-muted-foreground">
                  <tr className="border-b">
                    <th scope="col" className="px-4 py-2 text-left font-medium">Line</th>
                    <th scope="col" className="px-2 py-2 text-left font-medium">Account</th>
                    <th scope="col" className="px-4 py-2 text-right font-medium">Result</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {results.map((r) => {
                    const status = STATUS[r.outcome.status]
                    return (
                      <tr key={r.line} className={cn(r.outcome.status === "failed" && "bg-destructive/5")}>
                        <td className="px-4 py-2.5 align-top text-muted-foreground figure">{r.line}</td>
                        <td className="px-2 py-2.5 align-top">
                          {"beneficiary" in r.outcome ? (
                            <BeneficiaryName beneficiary={r.outcome.beneficiary} />
                          ) : (
                            <>
                              <span className="block">
                                {r.bank} · <span className="font-mono">{r.accountNumber || "Missing"}</span>
                              </span>
                              <span className={cn("block text-xs", r.outcome.status === "failed" ? "text-destructive" : "text-muted-foreground")}>
                                {r.outcome.error}
                              </span>
                            </>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-right align-top">
                          <Badge variant={status.variant}>{status.label}</Badge>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <fieldset disabled={busy} className="grid min-w-0 gap-5">
            <Field>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <FieldLabel htmlFor="import-csv">Accounts</FieldLabel>
                <div className="flex flex-wrap gap-2">
                  <Button variant="ghost" size="sm" asChild>
                    <a href={csvHref(BENEFICIARY_CSV_TEMPLATE)} download="linkpay-beneficiaries.csv">
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
                id="import-csv"
                rows={6}
                spellCheck={false}
                className="font-mono text-xs"
                placeholder={"account_number,bank,nickname\n0123456789,Access Bank,Ada (cashier)"}
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
              <FieldDescription>One account per line: account number, bank name or code, then an optional nickname.</FieldDescription>
            </Field>

            {rows.length > 0 && (
              <div className="overflow-hidden rounded-xl border">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/60 px-4 py-2.5 text-sm">
                  <span>{accounts(ready.length)} to check and save</span>
                  {problems > 0 && (
                    <span className="text-destructive">
                      {problems} {problems === 1 ? "line has" : "lines have"} a problem
                    </span>
                  )}
                </div>
                <div className="max-h-72 overflow-y-auto">
                  <table className="w-full text-sm">
                    <caption className="sr-only">Lines to import</caption>
                    <thead className="text-xs text-muted-foreground">
                      <tr className="border-b">
                        <th scope="col" className="px-4 py-2 text-left font-medium">Line</th>
                        <th scope="col" className="px-2 py-2 text-left font-medium">Account</th>
                        <th scope="col" className="px-2 py-2 text-left font-medium">Bank</th>
                        <th scope="col" className="px-4 py-2 text-left font-medium">Nickname</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {rows.map((r) => (
                        <tr key={r.line} className={cn(r.error && "bg-destructive/5")}>
                          <td className="px-4 py-2 align-top text-muted-foreground figure">{r.line}</td>
                          <td className="px-2 py-2 align-top">
                            <span className="font-mono">{r.accountNumber || "Missing"}</span>
                            {r.error && <span className="block text-xs text-destructive">{r.error}</span>}
                          </td>
                          <td className="px-2 py-2 align-top">{label(r)}</td>
                          <td className="px-4 py-2 align-top break-words text-muted-foreground">{r.nickname ?? ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            {problems > 0 && ready.length > 0 && !tooMany && (
              <p className="text-sm text-muted-foreground">Lines with a problem are left out. Fix them above to include them.</p>
            )}
            {tooMany && <p className="text-sm text-destructive">That&apos;s {rows.length} lines. Import up to {MAX_CSV_ROWS} at a time.</p>}
          </fieldset>
        )}

        {busy && (
          <p role="status" className="inline-flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Checking {results ? accounts(again) : accounts(ready.length)} with their banks. This can take a minute.
          </p>
        )}

        <DialogFooter>
          {results ? (
            <>
              {again > 0 && (
                <Button variant="outline" className="sm:mr-auto" onClick={retry} disabled={busy}>
                  {busy ? <Spinner /> : <RotateCw data-icon="inline-start" aria-hidden />}
                  Check {again === 1 ? "it" : `those ${again}`} again
                </Button>
              )}
              <Button variant="outline" onClick={reset} disabled={busy}>
                Import more
              </Button>
              <Button onClick={close} disabled={busy}>
                Done
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={close} disabled={busy}>
                Cancel
              </Button>
              <Button onClick={start} disabled={busy || !banks || !ready.length || tooMany}>
                {busy ? <Spinner /> : <Upload data-icon="inline-start" aria-hidden />}
                {ready.length ? `Import ${accounts(ready.length)}` : "Import"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
