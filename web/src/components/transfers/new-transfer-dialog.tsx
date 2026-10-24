"use client"

import { useEffect, useState } from "react"
import { BookUser, Check, ChevronsUpDown, Send } from "lucide-react"
import { toast } from "sonner"
import { createTransfer, listBanks, quoteFee, resolveAccount } from "@/app/(dashboard)/transfers/actions"
import { FormError } from "@/components/common/form-error"
import { NairaInput } from "@/components/common/naira-input"
import { BeneficiaryPickerDialog } from "@/components/payouts/beneficiary-picker-dialog"
import { BeneficiaryName } from "@/components/payouts/parts"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Field, FieldContent, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { NativeSelect } from "@/components/ui/native-select"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Spinner } from "@/components/ui/spinner"
import { useTransactionPin } from "@/components/transaction-pin/use-transaction-pin"
import { useIdempotencyKey } from "@/hooks/use-idempotency-key"
import type { AccountWithBalance, Bank, Beneficiary, BranchRef, FeeQuote, ResolvedAccount } from "@/lib/api/types"
import { formatNaira } from "@/lib/format"
import { approvalsNeeded, parseNairaToKobo } from "@/lib/transfers"
import { cn } from "@/lib/utils"

/** A branch account money can be sent from. */
export type SourceAccount = AccountWithBalance & { branch: BranchRef }

type Props = {
  /** Accounts the member can send from (their branches only). */
  accounts: SourceAccount[]
  /** Preselected source, e.g. the branch picked in the sidebar. */
  defaultBranchId?: string
  /** Opens on this saved beneficiary ("Pay" on a beneficiary's page). */
  beneficiary?: Beneficiary
  children: React.ReactNode
}

type Recipient = "bank" | "saved" | "branch"

const RECIPIENT_LABELS: Record<Recipient, string> = { bank: "Bank account", saved: "Saved", branch: "Another branch" }

const available = (a?: SourceAccount) => a?.balance?.availableKobo ?? a?.balance?.amountKobo

/**
 * Send money to a bank account, a saved beneficiary or another branch: details, then a review with the fee before
 * anything moves. A saved beneficiary is paid under the name saved with it, so it needs no name check; a new bank
 * account can be saved as a beneficiary as it's paid.
 */
export function NewTransferDialog({ accounts, defaultBranchId, beneficiary: initialBeneficiary, children }: Props) {
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState<"details" | "review">("details")
  const idempotency = useIdempotencyKey()
  const pin = useTransactionPin()

  const [sourceId, setSourceId] = useState(defaultBranchId ?? accounts[0]?.branch._id ?? "")
  const [to, setTo] = useState<Recipient>(initialBeneficiary ? "saved" : "bank")
  const [banks, setBanks] = useState<Bank[] | null>(null)
  const [bankUuid, setBankUuid] = useState("")
  const [accountNumber, setAccountNumber] = useState("")
  const [saveNew, setSaveNew] = useState(false)
  const [beneficiary, setBeneficiary] = useState<Beneficiary | null>(initialBeneficiary ?? null)
  // The latest name enquiry, keyed by "bank:account number" so a stale answer never shows.
  const [lookup, setLookup] = useState<{ key: string; data?: ResolvedAccount; error?: string } | null>(null)
  const [targetBranch, setTargetBranch] = useState("")
  const [amount, setAmount] = useState("")
  const [narration, setNarration] = useState("")
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [quote, setQuote] = useState<FeeQuote | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const lookupKey = to === "bank" && bankUuid && /^\d{10}$/.test(accountNumber) ? `${bankUuid}:${accountNumber}` : null
  const current = lookup && lookup.key === lookupKey ? lookup : null
  const resolved = current?.data ?? null
  const resolveError = current?.error
  const resolving = !!lookupKey && !current
  const source = accounts.find((a) => a.branch._id === sourceId)
  const targets = accounts.filter((a) => a.branch._id !== sourceId)
  const amountKobo = parseNairaToKobo(amount)
  // The business's own branches are never saved as beneficiaries (they're paid as branches).
  const canSave = to === "bank" && resolved?.kind !== "internal"
  const saving = canSave && saveNew

  function reset() {
    setStep("details")
    idempotency.reset()
    setSourceId(defaultBranchId ?? accounts[0]?.branch._id ?? "")
    setTo(initialBeneficiary ? "saved" : "bank")
    setBankUuid("")
    setAccountNumber("")
    setSaveNew(false)
    setBeneficiary(initialBeneficiary ?? null)
    setLookup(null)
    setTargetBranch("")
    setAmount("")
    setNarration("")
    setErrors({})
    setQuote(null)
    setError(undefined)
  }

  // Banks load once, the first time the dialog opens.
  useEffect(() => {
    if (!open || banks) return
    listBanks().then((r) => (r.ok ? setBanks(r.data) : setError(r.error)))
  }, [open, banks])

  // Name enquiry as soon as there's a bank and 10 digits.
  useEffect(() => {
    if (!lookupKey) return
    let stale = false
    const [uuid, number] = lookupKey.split(":")
    resolveAccount({ accountNumber: number, bankUuid: uuid }).then((r) => {
      if (!stale) setLookup(r.ok ? { key: lookupKey, data: r.data } : { key: lookupKey, error: r.error })
    })
    return () => {
      stale = true
    }
  }, [lookupKey])

  async function review(e: React.FormEvent) {
    e.preventDefault()
    const next: Record<string, string> = {}
    if (!source) next.source = "Choose the account to send from."
    if (to === "bank") {
      if (!bankUuid) next.bank = "Choose the bank."
      if (!/^\d{10}$/.test(accountNumber)) next.accountNumber = "Account numbers are 10 digits."
      else if (!resolved) next.accountNumber = resolveError ?? "Wait for the account name to show."
    } else if (to === "saved") {
      if (!beneficiary) next.beneficiary = "Choose who to pay."
    } else if (!targetBranch) next.targetBranch = "Choose the branch to send to."
    if (amountKobo === null || amountKobo < 100) next.amount = "Enter an amount of at least ₦1."
    setErrors(next)
    if (Object.keys(next).length) return

    setBusy(true)
    setError(undefined)
    // With the source branch, so the approval shown counts the member's last 24 hours from it, as sending does.
    const result = await quoteFee(amountKobo!, sourceId)
    setBusy(false)
    if (!result.ok) return setError(result.error)
    setQuote(result.data)
    const spendable = available(source)
    if (spendable !== undefined && result.data.totalKobo > spendable) {
      return setErrors({ amount: `With the ${formatNaira(result.data.feeKobo)} fee this needs ${formatNaira(result.data.totalKobo)}. ${source!.label} has ${formatNaira(spendable)} available.` })
    }
    setStep("review")
  }

  async function send() {
    setBusy(true)
    setError(undefined)
    const request = {
      branch: sourceId,
      amountKobo: amountKobo!,
      narration: narration.trim() || undefined,
      recipient:
        to === "bank"
          ? { type: "bank" as const, accountNumber, bankUuid }
          : to === "saved"
            ? { type: "beneficiary" as const, beneficiary: beneficiary!._id }
            : { type: "branch" as const, branch: targetBranch },
      saveBeneficiary: saving ? (true as const) : undefined,
    }
    // Sending the same details again keeps the key, whatever went wrong (it may have gone through, or the
    // PIN was wrong); changing anything that's sent gets a new one, choosing another beneficiary or ticking
    // "Save to beneficiaries" included. The PIN isn't part of the details.
    const idempotencyKey = idempotency.keyFor(request)
    const amount = formatNaira(request.amountKobo)
    const recipient = recipientLabel
    const result = await pin.confirm({
      purpose: `send ${amount} to ${recipient ?? "this account"}${quote?.needsApproval ? " for approval" : ""}`,
      confirmLabel: quote?.needsApproval ? "Send for approval" : `Send ${amount}`,
      run: (transactionPin) => createTransfer({ ...request, idempotencyKey }, transactionPin),
    })
    setBusy(false)
    if (!result) return
    if (!result.ok) {
      // Deleted since it was chosen: choose again (or send to the account by its number).
      if (result.code === "BENEFICIARY_NOT_FOUND" && to === "saved") {
        setBeneficiary(null)
        setStep("details")
        return setError("That beneficiary is no longer saved. Choose another, or send to the account by its number.")
      }
      return setError(result.error)
    }
    const t = result.data
    if (t.status === "pending_approval") {
      const levels = t.approval?.levels.length ?? 1
      toast.success(
        levels > 1
          ? `Sent for approval. It goes through ${levels} levels, and the money is held until the last one approves.`
          : "Sent for approval. The money is held until someone approves it.",
      )
    }
    else if (t.status === "failed") toast.error(`The transfer failed: ${t.failureReason ?? "the bank couldn't complete it"}.`)
    else toast.success(`${formatNaira(t.amountKobo)} is on its way to ${t.recipient.branch?.name ?? t.recipient.accountName}.`)
    if (saving && t.recipient.beneficiary) toast.success(`${t.recipient.accountName} is saved to your beneficiaries.`)
    setOpen(false)
    reset()
  }

  const recipientLabel =
    to === "branch"
      ? targets.find((a) => a.branch._id === targetBranch)?.branch.name
      : to === "saved"
        ? beneficiary?.accountName
        : resolved?.accountName
  const bank = banks?.find((b) => b.uuid === bankUuid)
  const options: Recipient[] = targets.length > 0 ? ["bank", "saved", "branch"] : ["bank", "saved"]

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) reset()
      }}
    >
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{step === "details" ? "New transfer" : "Check and send"}</DialogTitle>
          <DialogDescription>
            {step === "details"
              ? "Send to any Nigerian bank account or someone you've saved, or move money between your branches."
              : "Nothing moves until you confirm."}
          </DialogDescription>
        </DialogHeader>

        <FormError message={error} />

        {step === "details" ? (
          <form id="transfer-form" onSubmit={review} noValidate className="grid gap-5">
            <Field data-invalid={!!errors.source}>
              <FieldLabel htmlFor="transfer-source">From</FieldLabel>
              <NativeSelect id="transfer-source" value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
                {accounts.map((a) => (
                  <option key={a._id} value={a.branch._id}>
                    {a.branch.name} · {a.accountNumber}
                    {available(a) !== undefined ? ` · ${formatNaira(available(a)!)} available` : ""}
                  </option>
                ))}
              </NativeSelect>
              {errors.source && <FieldError>{errors.source}</FieldError>}
            </Field>

            <div role="radiogroup" aria-label="Send to" className="inline-flex h-9 w-fit max-w-full items-center gap-0.5 rounded-full bg-muted p-0.5">
              {options.map((v) => (
                <button
                  key={v}
                  type="button"
                  role="radio"
                  aria-checked={to === v}
                  onClick={() => {
                    setTo(v)
                    setErrors({})
                  }}
                  className={cn(
                    "h-8 rounded-full px-2 text-[13px] font-medium whitespace-nowrap transition-colors duration-150 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none sm:px-4 sm:text-sm",
                    to === v ? "bg-card text-foreground shadow-surface" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {RECIPIENT_LABELS[v]}
                </button>
              ))}
            </div>

            {to === "saved" ? (
              <Field data-invalid={!!errors.beneficiary}>
                <FieldLabel htmlFor="transfer-beneficiary">To</FieldLabel>
                {beneficiary ? (
                  <div className="flex items-center gap-3 rounded-[10px] border px-3 py-2.5">
                    <BeneficiaryName beneficiary={beneficiary} className="flex-1" />
                    <BeneficiaryPickerDialog purpose="send" selected={beneficiary._id} onPick={setBeneficiary}>
                      <Button id="transfer-beneficiary" type="button" variant="ghost" size="sm" aria-label={`Change who to pay (now ${beneficiary.accountName})`}>
                        Change
                      </Button>
                    </BeneficiaryPickerDialog>
                  </div>
                ) : (
                  <BeneficiaryPickerDialog
                    purpose="send"
                    onPick={(b) => {
                      setBeneficiary(b)
                      setErrors((prev) => ({ ...prev, beneficiary: "" }))
                    }}
                  >
                    <Button
                      id="transfer-beneficiary"
                      type="button"
                      variant="outline"
                      aria-invalid={!!errors.beneficiary}
                      className="h-10 w-full justify-between rounded-[10px] px-3 font-normal"
                    >
                      <span className="text-muted-foreground">Choose a beneficiary</span>
                      <BookUser className="text-muted-foreground" aria-hidden />
                    </Button>
                  </BeneficiaryPickerDialog>
                )}
                {errors.beneficiary ? (
                  <FieldError>{errors.beneficiary}</FieldError>
                ) : (
                  <FieldDescription>Paid under the name the bank gave when they were saved, so there&apos;s no new check.</FieldDescription>
                )}
              </Field>
            ) : to === "bank" ? (
              <>
                <Field data-invalid={!!errors.bank}>
                  <FieldLabel htmlFor="transfer-bank">Bank</FieldLabel>
                  <BankPicker banks={banks} value={bankUuid} onChange={setBankUuid} invalid={!!errors.bank} />
                  {errors.bank && <FieldError>{errors.bank}</FieldError>}
                </Field>
                <Field data-invalid={!!errors.accountNumber}>
                  <FieldLabel htmlFor="transfer-account">Account number</FieldLabel>
                  <Input
                    id="transfer-account"
                    inputMode="numeric"
                    autoComplete="off"
                    maxLength={10}
                    className="font-mono tracking-[0.04em]"
                    value={accountNumber}
                    aria-invalid={!!errors.accountNumber}
                    onChange={(e) => setAccountNumber(e.target.value.replace(/\D/g, "").slice(0, 10))}
                  />
                  <p role="status" aria-live="polite" className="min-h-5 text-sm">
                    {resolving ? (
                      <span className="inline-flex items-center gap-2 text-muted-foreground">
                        <Spinner /> Checking the account
                      </span>
                    ) : resolved ? (
                      <ResolvedName account={resolved} />
                    ) : resolveError ? (
                      <span className="text-destructive">{resolveError}</span>
                    ) : null}
                  </p>
                  {errors.accountNumber && !resolveError && <FieldError>{errors.accountNumber}</FieldError>}
                </Field>
                {canSave && (
                  <Field orientation="horizontal">
                    <Checkbox id="transfer-save" checked={saveNew} onCheckedChange={(v) => setSaveNew(v === true)} />
                    <FieldContent>
                      <FieldLabel htmlFor="transfer-save" className="font-normal">
                        Save to beneficiaries
                      </FieldLabel>
                      <FieldDescription>Anyone on your team can then pay them again without typing the account.</FieldDescription>
                    </FieldContent>
                  </Field>
                )}
              </>
            ) : (
              <Field data-invalid={!!errors.targetBranch}>
                <FieldLabel htmlFor="transfer-target">To</FieldLabel>
                <NativeSelect id="transfer-target" value={targetBranch} onChange={(e) => setTargetBranch(e.target.value)}>
                  <option value="">Choose a branch</option>
                  {targets.map((a) => (
                    <option key={a._id} value={a.branch._id}>
                      {a.branch.name} · {a.accountNumber}
                    </option>
                  ))}
                </NativeSelect>
                {errors.targetBranch && <FieldError>{errors.targetBranch}</FieldError>}
              </Field>
            )}

            <Field data-invalid={!!errors.amount}>
              <FieldLabel htmlFor="transfer-amount">Amount</FieldLabel>
              <NairaInput id="transfer-amount" value={amount} invalid={!!errors.amount} onChange={setAmount} />
              {errors.amount ? (
                <FieldError>{errors.amount}</FieldError>
              ) : (
                available(source) !== undefined && (
                  <FieldDescription>
                    <span className="figure">{formatNaira(available(source)!)}</span> available in {source!.branch.name}
                  </FieldDescription>
                )
              )}
            </Field>

            <Field>
              <FieldLabel htmlFor="transfer-narration">Narration (optional)</FieldLabel>
              <Input id="transfer-narration" maxLength={100} value={narration} onChange={(e) => setNarration(e.target.value)} placeholder="October rent" />
              <FieldDescription>The recipient sees this on their statement.</FieldDescription>
            </Field>
          </form>
        ) : (
          quote && (
            <div className="grid gap-4">
              <dl className="divide-y rounded-xl border text-sm">
                <ReviewRow label="From" value={`${source?.branch.name} · ${source?.accountNumber}`} />
                <ReviewRow
                  label="To"
                  value={
                    <span className="grid justify-items-end">
                      <span className="font-medium">{recipientLabel}</span>
                      {to === "saved" && beneficiary?.nickname && <span className="text-xs text-muted-foreground">{beneficiary.nickname}</span>}
                      <span className="text-xs text-muted-foreground">
                        {to === "bank"
                          ? `${bank?.name} · ${accountNumber}`
                          : to === "saved"
                            ? `${beneficiary?.bankName ?? "Bank"} · ${beneficiary?.accountNumber}`
                            : targets.find((a) => a.branch._id === targetBranch)?.accountNumber}
                      </span>
                    </span>
                  }
                />
                {narration.trim() && <ReviewRow label="Narration" value={narration.trim()} />}
                <ReviewRow label="Amount" value={<span className="figure">{formatNaira(quote.amountKobo)}</span>} />
                <ReviewRow
                  label="Fee"
                  value={
                    <span className="grid justify-items-end">
                      <span className="figure">{formatNaira(quote.feeKobo)}</span>
                      {quote.stampDutyKobo > 0 && (
                        <span className="text-xs text-muted-foreground">
                          includes <span className="figure">{formatNaira(quote.stampDutyKobo)}</span> stamp duty
                        </span>
                      )}
                    </span>
                  }
                />
                <ReviewRow label="Total from the account" value={<span className="type-display text-xl figure">{formatNaira(quote.totalKobo)}</span>} />
              </dl>
              {saving && <p className="text-sm text-muted-foreground">{recipientLabel} will be saved to your beneficiaries.</p>}
              {quote.needsApproval && (
                <p className="rounded-lg bg-warning-subtle px-3 py-2.5 text-sm text-warning-foreground">
                  {(quote.approvalLevels ?? 1) > 1
                    ? `${approvalsNeeded(quote.approvalLevels)}, one level after another. The money is held until the last one approves.`
                    : "This transfer needs a second person to approve it. The money is held until they do."}
                </p>
              )}
            </div>
          )
        )}

        <DialogFooter>
          {step === "details" ? (
            <>
              <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" form="transfer-form" disabled={busy || resolving}>
                {busy && <Spinner />}
                Continue
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => setStep("details")} disabled={busy}>
                Back
              </Button>
              <Button onClick={send} disabled={busy}>
                {busy ? <Spinner /> : <Send data-icon="inline-start" aria-hidden />}
                {quote?.needsApproval ? "Send for approval" : `Send ${quote ? formatNaira(quote.amountKobo) : ""}`}
              </Button>
            </>
          )}
        </DialogFooter>
        {pin.dialog}
      </DialogContent>
    </Dialog>
  )
}

export function ReviewRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 px-4 py-3">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right break-words">{value}</dd>
    </div>
  )
}

/** The name from the bank's name enquiry, with the branch or LinkPay business behind the account. */
export function ResolvedName({ account }: { account: ResolvedAccount }) {
  return (
    <span className="inline-flex items-center gap-1.5 font-medium">
      <Check className="size-4 shrink-0 text-success-foreground" aria-hidden />
      {account.accountName}
      {account.kind !== "bank" && account.label && (
        <span className="font-normal text-muted-foreground">
          {account.kind === "internal" ? `, your ${account.label} branch` : `, ${account.label} on LinkPay`}
        </span>
      )}
    </span>
  )
}

/** Searchable bank list. */
export function BankPicker({
  banks,
  value,
  onChange,
  invalid,
  id = "transfer-bank",
}: {
  banks: Bank[] | null
  value: string
  onChange: (uuid: string) => void
  invalid?: boolean
  id?: string
}) {
  const [open, setOpen] = useState(false)
  const chosen = banks?.find((b) => b.uuid === value)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-invalid={invalid}
          disabled={!banks}
          className="h-10 w-full justify-between rounded-[10px] px-3 font-normal"
        >
          <span className={cn("truncate", !chosen && "text-muted-foreground")}>
            {chosen?.name ?? (banks ? "Choose a bank" : "Loading banks")}
          </span>
          {banks ? <ChevronsUpDown className="text-muted-foreground" aria-hidden /> : <Spinner />}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) p-0" align="start">
        <Command>
          <CommandInput placeholder="Search banks" />
          <CommandList>
            <CommandEmpty>No bank by that name.</CommandEmpty>
            <CommandGroup>
              {banks?.map((b) => (
                <CommandItem
                  key={b.uuid}
                  value={b.name}
                  onSelect={() => {
                    onChange(b.uuid)
                    setOpen(false)
                  }}
                >
                  {b.name}
                  {b.uuid === value && <Check className="ml-auto size-4" aria-label="Selected" />}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
