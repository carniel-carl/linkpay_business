"use client"

import { useEffect, useState } from "react"
import { Check, ChevronsUpDown, Send } from "lucide-react"
import { toast } from "sonner"
import { createTransfer, listBanks, quoteFee, resolveAccount } from "@/app/(dashboard)/transfers/actions"
import { FormError } from "@/components/common/form-error"
import { Button } from "@/components/ui/button"
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
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group"
import { NativeSelect } from "@/components/ui/native-select"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Spinner } from "@/components/ui/spinner"
import type { AccountWithBalance, Bank, BranchRef, FeeQuote, ResolvedAccount } from "@/lib/api/types"
import { formatNaira } from "@/lib/format"
import { parseNairaToKobo } from "@/lib/transfers"
import { cn } from "@/lib/utils"

/** A branch account money can be sent from. */
export type SourceAccount = AccountWithBalance & { branch: BranchRef }

type Props = {
  /** Accounts the member can send from (their branches only). */
  accounts: SourceAccount[]
  /** Preselected source, e.g. the branch picked in the sidebar. */
  defaultBranchId?: string
  children: React.ReactNode
}

const newKey = () => crypto.randomUUID().replaceAll("-", "")
const available = (a?: SourceAccount) => a?.balance?.availableKobo ?? a?.balance?.amountKobo

/** Send money to a bank account or another branch: details, then a review with the fee before anything moves. */
export function NewTransferDialog({ accounts, defaultBranchId, children }: Props) {
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState<"details" | "review">("details")
  const [key, setKey] = useState(newKey)

  const [sourceId, setSourceId] = useState(defaultBranchId ?? accounts[0]?.branch._id ?? "")
  const [to, setTo] = useState<"bank" | "branch">("bank")
  const [banks, setBanks] = useState<Bank[] | null>(null)
  const [bankUuid, setBankUuid] = useState("")
  const [accountNumber, setAccountNumber] = useState("")
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

  function reset() {
    setStep("details")
    setKey(newKey())
    setSourceId(defaultBranchId ?? accounts[0]?.branch._id ?? "")
    setTo("bank")
    setBankUuid("")
    setAccountNumber("")
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
    } else if (!targetBranch) next.targetBranch = "Choose the branch to send to."
    if (amountKobo === null || amountKobo < 100) next.amount = "Enter an amount of at least ₦1."
    setErrors(next)
    if (Object.keys(next).length) return

    setBusy(true)
    setError(undefined)
    const result = await quoteFee(amountKobo!)
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
    const result = await createTransfer({
      branch: sourceId,
      amountKobo: amountKobo!,
      narration: narration.trim() || undefined,
      recipient: to === "bank" ? { type: "bank", accountNumber, bankUuid } : { type: "branch", branch: targetBranch },
      idempotencyKey: key,
    })
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      // Anything that changes what's sent gets a new key; a plain retry keeps it.
      if (result.code && result.code !== "ACCOUNT_BUSY") setKey(newKey())
      return
    }
    const t = result.data
    if (t.status === "pending_approval") toast.success("Sent for approval. The money is held until someone approves it.")
    else if (t.status === "failed") toast.error(`The transfer failed: ${t.failureReason ?? "the bank couldn't complete it"}.`)
    else toast.success(`${formatNaira(t.amountKobo)} is on its way to ${t.recipient.branch?.name ?? t.recipient.accountName}.`)
    setOpen(false)
    reset()
  }

  const recipientLabel =
    to === "branch" ? targets.find((a) => a.branch._id === targetBranch)?.branch.name : resolved?.accountName
  const bank = banks?.find((b) => b.uuid === bankUuid)

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
              ? "Send to any Nigerian bank account, or move money between your branches."
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

            {targets.length > 0 && (
              <div role="radiogroup" aria-label="Send to" className="inline-flex h-9 w-fit items-center gap-0.5 rounded-full bg-muted p-0.5">
                {(["bank", "branch"] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    role="radio"
                    aria-checked={to === v}
                    onClick={() => setTo(v)}
                    className={cn(
                      "h-8 rounded-full px-4 text-sm font-medium transition-colors duration-150 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                      to === v ? "bg-card text-foreground shadow-surface" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {v === "bank" ? "Bank account" : "Another branch"}
                  </button>
                ))}
              </div>
            )}

            {to === "bank" ? (
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
                      <span className="inline-flex items-center gap-1.5 font-medium">
                        <Check className="size-4 text-success-foreground" aria-hidden />
                        {resolved.accountName}
                        {resolved.kind !== "bank" && resolved.label && (
                          <span className="font-normal text-muted-foreground">
                            {resolved.kind === "internal" ? `, your ${resolved.label} branch` : `, ${resolved.label} on LinkPay`}
                          </span>
                        )}
                      </span>
                    ) : resolveError ? (
                      <span className="text-destructive">{resolveError}</span>
                    ) : null}
                  </p>
                  {errors.accountNumber && !resolveError && <FieldError>{errors.accountNumber}</FieldError>}
                </Field>
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
              <InputGroup>
                <InputGroupAddon>
                  <InputGroupText>₦</InputGroupText>
                </InputGroupAddon>
                <InputGroupInput
                  id="transfer-amount"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="0.00"
                  className="figure"
                  value={amount}
                  aria-invalid={!!errors.amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </InputGroup>
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
                      <span className="text-xs text-muted-foreground">
                        {to === "bank" ? `${bank?.name} · ${accountNumber}` : targets.find((a) => a.branch._id === targetBranch)?.accountNumber}
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
              {quote.needsApproval && (
                <p className="rounded-lg bg-warning-subtle px-3 py-2.5 text-sm text-warning-foreground">
                  This transfer needs a second person to approve it. The money is held until they do.
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
      </DialogContent>
    </Dialog>
  )
}

function ReviewRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 px-4 py-3">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right break-words">{value}</dd>
    </div>
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
