"use client"

import { useState } from "react"
import { Download } from "lucide-react"
import { toast } from "sonner"
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
import { Field, FieldDescription, FieldError, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { NativeSelect } from "@/components/ui/native-select"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Spinner } from "@/components/ui/spinner"
import { ApiError, friendlyMessage } from "@/lib/api/errors"
import type { StatementFormat } from "@/lib/api/types"
import { todayInLagos } from "@/lib/invoices"
import {
  periodError,
  presetRange,
  rangeLabel,
  STATEMENT_FORMATS,
  STATEMENT_PERIOD_LABELS,
  STATEMENT_PERIODS,
  statementHref,
  type StatementPeriod,
} from "@/lib/statements"
import { cn } from "@/lib/utils"

/** A branch with an account, as the dialog offers it. */
export type StatementAccount = { branchId: string; name: string; accountNumber: string; bankName?: string }

const SESSION_ENDED = "Your session has ended. Sign in again to download the statement."

/** The file name the server gave the download, or a plain one. */
function fileName(disposition: string | null, fallback: string) {
  const match = /filename="([^"]+)"/.exec(disposition ?? "")
  return match?.[1] ?? fallback
}

/** Saves a downloaded file under its name. */
function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = name
  document.body.appendChild(link)
  link.click()
  link.remove()
  // Long enough for the browser to have started the save.
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/**
 * "Download statement" on Transactions: one branch account, a period (this month, last month, the last three months
 * or chosen days) and PDF or CSV. The file comes through this server's route; what the API refuses is shown here.
 */
export function StatementDialog({ accounts, defaultBranchId }: { accounts: StatementAccount[]; defaultBranchId?: string }) {
  const start = () => accounts.find((a) => a.branchId === defaultBranchId)?.branchId ?? accounts[0]?.branchId ?? ""
  const [open, setOpen] = useState(false)
  const [branch, setBranch] = useState(start)
  const [period, setPeriod] = useState<StatementPeriod>("this_month")
  const [custom, setCustom] = useState({ from: "", to: "" })
  const [format, setFormat] = useState<StatementFormat>("pdf")
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  const today = todayInLagos()
  const range = period === "custom" ? custom : presetRange(period, today)
  const rangeProblem = periodError(range.from, range.to, today)
  const account = accounts.find((a) => a.branchId === branch)

  async function download(e: React.FormEvent) {
    e.preventDefault()
    setSubmitted(true)
    setError(undefined)
    if (rangeProblem || !account) return
    setBusy(true)
    try {
      // Manual redirects: a session that ended sends the proxy's sign-in redirect, which isn't the file.
      const res = await fetch(statementHref({ branch, from: range.from, to: range.to, format }), { cache: "no-store", redirect: "manual" })
      if (res.type === "opaqueredirect") {
        setError(SESSION_ENDED)
        return
      }
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        // The route sends the session, so a 401 for it means it ended (signed out elsewhere, or expired), as above.
        const err = new ApiError(res.status, body?.error ?? "We couldn't make the statement.", body?.code, body?.details, undefined, true)
        setError(err.sessionExpired ? SESSION_ENDED : friendlyMessage(err))
        return
      }
      const type = res.headers.get("content-type") ?? ""
      if (!type.startsWith("application/pdf") && !type.startsWith("text/csv")) {
        setError("We couldn't make the statement. Try again in a moment.")
        return
      }
      const name = fileName(res.headers.get("content-disposition"), `linkpay-statement-${range.from}-${range.to}.${format}`)
      save(await res.blob(), name)
      toast.success(`Statement for ${account.name}, ${rangeLabel(range.from, range.to)}, downloaded.`)
      setOpen(false)
    } catch {
      setError("We can't reach LinkPay right now. Check your connection and try again.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return
        setOpen(next)
        if (next) {
          setBranch(start())
          setSubmitted(false)
          setError(undefined)
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline">
          <Download data-icon="inline-start" aria-hidden />
          Download statement
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Download a statement</DialogTitle>
          <DialogDescription>
            Every completed payment into and out of one account, with totals, in Lagos time. Opening and closing
            balances appear where the bank reported them, from the first day they were recorded.
          </DialogDescription>
        </DialogHeader>
        <FormError message={error} />
        <form id="statement-form" onSubmit={download} noValidate className="grid gap-6">
          {accounts.length > 1 ? (
            <Field>
              <FieldLabel htmlFor="statement-account">Account</FieldLabel>
              <NativeSelect id="statement-account" value={branch} onChange={(e) => setBranch(e.target.value)} disabled={busy}>
                {accounts.map((a) => (
                  <option key={a.branchId} value={a.branchId}>
                    {a.name} · {a.accountNumber}
                  </option>
                ))}
              </NativeSelect>
              {account?.bankName && <FieldDescription>{account.bankName}</FieldDescription>}
            </Field>
          ) : (
            account && (
              <div className="grid gap-1 text-sm">
                <span className="font-medium">Account</span>
                <span className="text-muted-foreground">
                  {account.name} · <span className="figure">{account.accountNumber}</span>
                  {account.bankName ? ` · ${account.bankName}` : ""}
                </span>
              </div>
            )
          )}

          <FieldSet className="gap-3">
            <FieldLegend variant="label">Period</FieldLegend>
            <div role="radiogroup" aria-label="Period" className="flex flex-wrap gap-2">
              {STATEMENT_PERIODS.map((p) => {
                const checked = period === p
                return (
                  <button
                    key={p}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    disabled={busy}
                    onClick={() => {
                      setPeriod(p)
                      // A custom period starts from what was showing, so only the ends need changing.
                      if (p === "custom" && !custom.from && !custom.to && period !== "custom") setCustom(presetRange(period, today))
                    }}
                    className={cn(
                      "h-8 rounded-full border px-3.5 text-sm transition-colors duration-150",
                      "focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                      checked ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted",
                    )}
                  >
                    {STATEMENT_PERIOD_LABELS[p]}
                  </button>
                )
              })}
            </div>
            {period === "custom" ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field data-invalid={submitted && !!rangeProblem}>
                  <FieldLabel htmlFor="statement-from">From</FieldLabel>
                  <Input
                    id="statement-from"
                    type="date"
                    max={custom.to || today}
                    value={custom.from}
                    aria-invalid={submitted && !!rangeProblem}
                    disabled={busy}
                    onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))}
                  />
                </Field>
                <Field data-invalid={submitted && !!rangeProblem}>
                  <FieldLabel htmlFor="statement-to">To</FieldLabel>
                  <Input
                    id="statement-to"
                    type="date"
                    min={custom.from || undefined}
                    max={today}
                    value={custom.to}
                    aria-invalid={submitted && !!rangeProblem}
                    disabled={busy}
                    onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))}
                  />
                </Field>
                {submitted && rangeProblem ? (
                  <FieldError className="sm:col-span-2">{rangeProblem}</FieldError>
                ) : (
                  <FieldDescription className="sm:col-span-2">
                    {range.from && range.to && !rangeProblem ? rangeLabel(range.from, range.to) : "Up to 366 days, ending today or earlier."}
                  </FieldDescription>
                )}
              </div>
            ) : (
              <FieldDescription>{rangeLabel(range.from, range.to)}</FieldDescription>
            )}
          </FieldSet>

          <FieldSet className="gap-3">
            <FieldLegend variant="label" id="statement-format">
              Format
            </FieldLegend>
            <RadioGroup
              aria-labelledby="statement-format"
              value={format}
              onValueChange={(v) => setFormat(v as StatementFormat)}
              disabled={busy}
              className="gap-2"
            >
              {STATEMENT_FORMATS.map((f) => (
                <Label
                  key={f.value}
                  htmlFor={`statement-${f.value}`}
                  className="flex cursor-pointer items-start gap-3 rounded-[10px] border px-3.5 py-3 text-sm leading-snug font-normal transition-colors hover:bg-muted/50 has-data-[state=checked]:border-primary has-data-[state=checked]:bg-muted/40"
                >
                  <RadioGroupItem id={`statement-${f.value}`} value={f.value} className="mt-0.5" />
                  <span className="grid gap-0.5">
                    <span className="font-medium">{f.label}</span>
                    <span className="text-muted-foreground">{f.description}</span>
                  </span>
                </Label>
              ))}
            </RadioGroup>
          </FieldSet>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form="statement-form" disabled={busy || !account}>
            {busy ? <Spinner /> : <Download data-icon="inline-start" aria-hidden />}
            {busy ? "Preparing…" : `Download ${format.toUpperCase()}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
