"use client"

import { useState } from "react"
import { toast } from "sonner"
import { withdrawToSettlement } from "@/app/(dashboard)/settings/money-protection/actions"
import { quoteFee } from "@/app/(dashboard)/transfers/actions"
import { FormError } from "@/components/common/form-error"
import { NairaInput } from "@/components/common/naira-input"
import { useStepUp } from "@/components/security/step-up-dialog"
import type { SourceAccount } from "@/components/transfers/new-transfer-dialog"
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
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { NativeSelect } from "@/components/ui/native-select"
import { Spinner } from "@/components/ui/spinner"
import type { FeeQuote, SettlementAccount } from "@/lib/api/types"
import { formatNaira } from "@/lib/format"
import { parseNairaToKobo } from "@/lib/transfers"

const newKey = () => crypto.randomUUID().replaceAll("-", "")
const available = (a?: SourceAccount) => a?.balance?.availableKobo ?? a?.balance?.amountKobo

/** Withdraws from one of the business's branch accounts to an active settlement account. The approval rules apply. */
export function WithdrawDialog({ account, sources, children }: { account: SettlementAccount; sources: SourceAccount[]; children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const [sourceId, setSourceId] = useState(sources[0]?.branch._id ?? "")
  const [amount, setAmount] = useState("")
  const [narration, setNarration] = useState("")
  const [quote, setQuote] = useState<FeeQuote | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [key, setKey] = useState(newKey)
  const stepUp = useStepUp()
  const source = sources.find((s) => s.branch._id === sourceId)
  const amountKobo = parseNairaToKobo(amount)

  function reset() {
    setAmount("")
    setNarration("")
    setQuote(null)
    setErrors({})
    setError(undefined)
    setKey(newKey())
  }

  async function review() {
    const next: Record<string, string> = {}
    if (!source) next.source = "Choose the account to withdraw from."
    if (!amountKobo || amountKobo < 100) next.amount = "Enter an amount of at least ₦1."
    setErrors(next)
    if (Object.keys(next).length) return
    setBusy(true)
    setError(undefined)
    const result = await quoteFee(amountKobo!)
    setBusy(false)
    if (!result.ok) return setError(result.error)
    const spendable = available(source)
    if (spendable !== undefined && result.data.totalKobo > spendable) {
      return setErrors({ amount: `With the ${formatNaira(result.data.feeKobo)} fee this needs ${formatNaira(result.data.totalKobo)}. ${source!.branch.name} has ${formatNaira(spendable)} available.` })
    }
    setQuote(result.data)
  }

  async function withdraw() {
    setBusy(true)
    setError(undefined)
    const body = { branch: sourceId, amountKobo: amountKobo! }
    const result = await stepUp.confirm("settlement.withdraw", { id: account._id, ...body }, (proof) =>
      withdrawToSettlement(account._id, { ...body, narration: narration.trim() || undefined, idempotencyKey: key }, proof),
    )
    setBusy(false)
    if (!result) return
    if (!result.ok) {
      setError(result.error)
      if (result.code && result.code !== "ACCOUNT_BUSY") setKey(newKey())
      return
    }
    toast.success(
      result.data.status === "pending_approval"
        ? "Sent for approval. The money is held until it's approved."
        : `${formatNaira(result.data.amountKobo)} is on its way to ${account.accountName}.`,
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
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Withdraw</DialogTitle>
          <DialogDescription>
            To {account.accountName}, <span className="font-mono">{account.accountNumber}</span>, {account.bankName ?? "bank"}.
          </DialogDescription>
        </DialogHeader>

        {quote ? (
          <dl className="grid gap-3 rounded-xl bg-muted px-4 py-3 text-sm">
            <Row label="From" value={source?.branch.name ?? ""} />
            <Row label="Amount" value={formatNaira(quote.amountKobo)} />
            <Row label="Fee" value={formatNaira(quote.feeKobo)} />
            <Row label="Total" value={formatNaira(quote.totalKobo)} strong />
            {quote.needsApproval && <p className="text-muted-foreground">This needs approval before it goes. The money is held until then.</p>}
          </dl>
        ) : (
          <div className="grid gap-5">
            <Field data-invalid={!!errors.source || undefined}>
              <FieldLabel htmlFor="withdraw-source">From</FieldLabel>
              <NativeSelect id="withdraw-source" value={sourceId} onChange={(e) => setSourceId(e.target.value)} className="w-full">
                {sources.map((s) => (
                  <option key={s.branch._id} value={s.branch._id}>
                    {s.branch.name}
                    {available(s) !== undefined ? ` · ${formatNaira(available(s)!)} available` : ""}
                  </option>
                ))}
              </NativeSelect>
              <FieldError>{errors.source}</FieldError>
            </Field>
            <Field data-invalid={!!errors.amount || undefined}>
              <FieldLabel htmlFor="withdraw-amount">Amount</FieldLabel>
              <NairaInput id="withdraw-amount" value={amount} onChange={setAmount} invalid={!!errors.amount} />
              {available(source) !== undefined && (
                <FieldDescription>
                  <span className="figure">{formatNaira(available(source)!)}</span> available in {source!.branch.name}
                </FieldDescription>
              )}
              <FieldError>{errors.amount}</FieldError>
            </Field>
            <Field>
              <FieldLabel htmlFor="withdraw-narration">Narration (optional)</FieldLabel>
              <Input id="withdraw-narration" maxLength={100} value={narration} onChange={(e) => setNarration(e.target.value)} />
            </Field>
          </div>
        )}
        <FormError message={error} />

        <DialogFooter>
          {quote ? (
            <>
              <Button variant="outline" onClick={() => setQuote(null)} disabled={busy}>
                Back
              </Button>
              <Button onClick={withdraw} disabled={busy}>
                {busy && <Spinner />}
                {quote.needsApproval ? "Send for approval" : `Withdraw ${formatNaira(quote.amountKobo)}`}
              </Button>
            </>
          ) : (
            <Button onClick={review} disabled={busy || sources.length === 0}>
              {busy && <Spinner />}
              Continue
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
      {stepUp.dialog}
    </Dialog>
  )
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={strong ? "figure font-medium" : "figure"}>{value}</dd>
    </div>
  )
}
