"use client"

import { useState } from "react"
import { Lock } from "lucide-react"
import { toast } from "sonner"
import { createSafelock } from "@/app/(dashboard)/savings/actions"
import { FormError } from "@/components/common/form-error"
import { NairaInput } from "@/components/common/naira-input"
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
import { Field, FieldDescription, FieldError, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { NativeSelect } from "@/components/ui/native-select"
import { Spinner } from "@/components/ui/spinner"
import { useTransactionPin } from "@/components/transaction-pin/use-transaction-pin"
import { useIdempotencyKey } from "@/hooks/use-idempotency-key"
import type { SafelockLimits } from "@/lib/api/types"
import { formatNaira } from "@/lib/format"
import { addDays, daysBetween, formatDay, todayInLagos } from "@/lib/savings"
import { parseNairaToKobo } from "@/lib/transfers"
import { cn } from "@/lib/utils"
import type { PocketBranch } from "./pocket-form-dialog"

const PRESETS = [30, 90, 180, 365]

type Values = { branch: string; title: string; amount: string; unlockOn: string }

/** Lock money until a date: details, then a confirmation, since it can't be undone. The trigger is passed as children. */
export function SafelockFormDialog({
  branches,
  limits,
  defaultBranchId,
  children,
}: {
  /** Branches with a ready account. */
  branches: PocketBranch[]
  limits: SafelockLimits
  defaultBranchId?: string
  children: React.ReactNode
}) {
  const startBranch = branches.find((b) => b._id === defaultBranchId)?._id ?? branches[0]?._id ?? ""
  const blank = (): Values => ({ branch: startBranch, title: "", amount: "", unlockOn: "" })
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState<"details" | "confirm">("details")
  const [v, setV] = useState<Values>(blank)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState<string>()
  const [agreed, setAgreed] = useState(false)
  const [busy, setBusy] = useState(false)
  // One key per thing being locked: a double click, or a retry after any error (a dropped response, the
  // partner being down), locks once. Changing the name, branch, amount or date gets a new key.
  const idempotency = useIdempotencyKey()
  const pin = useTransactionPin()

  const set = <K extends keyof Values>(k: K, value: Values[K]) => setV((prev) => ({ ...prev, [k]: value }))
  const branch = branches.find((b) => b._id === v.branch)
  const kobo = parseNairaToKobo(v.amount)
  const today = todayInLagos()
  const days = v.unlockOn ? daysBetween(today, v.unlockOn) : null
  const presets = PRESETS.filter((d) => d >= limits.minDays && d <= limits.maxDays)

  function check(e: React.FormEvent) {
    e.preventDefault()
    const next: Record<string, string> = {}
    if (!v.branch) next.branch = "Choose a branch."
    if (!v.title.trim()) next.title = "Give the Safelock a name."
    if (kobo === null) next.amount = "Enter an amount."
    else if (kobo < limits.minAmountKobo) next.amount = `Lock at least ${formatNaira(limits.minAmountKobo)}.`
    else if (kobo > limits.maxAmountKobo) next.amount = `You can lock up to ${formatNaira(limits.maxAmountKobo)} at a time.`
    else if (branch?.availableKobo != null && kobo > branch.availableKobo)
      next.amount = `${branch.name} has ${formatNaira(branch.availableKobo)} available.`
    if (!v.unlockOn) next.unlockOn = "Choose when it unlocks."
    else if (v.unlockOn < limits.earliestUnlockOn || v.unlockOn > limits.latestUnlockOn)
      next.unlockOn = `Choose a date from ${formatDay(limits.earliestUnlockOn)} to ${formatDay(limits.latestUnlockOn)}.`
    setErrors(next)
    setError(undefined)
    if (Object.keys(next).length === 0) {
      setAgreed(false)
      setStep("confirm")
    }
  }

  async function lock() {
    setBusy(true)
    setError(undefined)
    const request = { branch: v.branch, title: v.title.trim(), amountKobo: kobo!, unlockOn: v.unlockOn }
    // The key belongs to the details, not the PIN, so a retry after a wrong PIN locks once.
    const idempotencyKey = idempotency.keyFor(request)
    const result = await pin.confirm({
      purpose: `lock ${formatNaira(request.amountKobo)} until ${formatDay(request.unlockOn)}`,
      confirmLabel: `Lock ${formatNaira(request.amountKobo)}`,
      run: (transactionPin) => createSafelock({ ...request, idempotencyKey }, transactionPin),
    })
    setBusy(false)
    if (!result) return
    if (!result.ok) {
      // Back to the form, with the problem next to the field it's about.
      const field =
        result.code === "SAFELOCK_TOO_SMALL" || result.code === "INSUFFICIENT_BALANCE"
          ? "amount"
          : result.code === "INVALID_UNLOCK_DATE"
            ? "unlockOn"
            : null
      if (field) setErrors({ [field]: result.error })
      else setError(result.error)
      setStep("details")
      return
    }
    toast.success(`${formatNaira(result.data.amountKobo)} is locked until ${formatDay(result.data.unlockOn)}.`)
    setOpen(false)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          setV(blank())
          setStep("details")
          setErrors({})
          setError(undefined)
          idempotency.reset()
        }
      }}
    >
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        {step === "details" ? (
          <>
            <DialogHeader>
              <DialogTitle>New Safelock</DialogTitle>
              <DialogDescription>
                Lock money away until a date you choose. It stays in the branch&apos;s account, but nobody can spend or take it out
                before then.
              </DialogDescription>
            </DialogHeader>
            <FormError message={error} />
            <form id="safelock-form" onSubmit={check} noValidate className="grid gap-6">
              <Field data-invalid={!!errors.title}>
                <FieldLabel htmlFor="safelock-title">Name</FieldLabel>
                <Input
                  id="safelock-title"
                  autoComplete="off"
                  maxLength={40}
                  placeholder="Office rent 2027"
                  value={v.title}
                  aria-invalid={!!errors.title}
                  onChange={(e) => set("title", e.target.value)}
                />
                {errors.title && <FieldError>{errors.title}</FieldError>}
              </Field>

              {branches.length > 1 && (
                <Field data-invalid={!!errors.branch}>
                  <FieldLabel htmlFor="safelock-branch">Branch</FieldLabel>
                  <NativeSelect id="safelock-branch" value={v.branch} onChange={(e) => set("branch", e.target.value)}>
                    {branches.map((b) => (
                      <option key={b._id} value={b._id}>
                        {b.name}
                      </option>
                    ))}
                  </NativeSelect>
                  {errors.branch && <FieldError>{errors.branch}</FieldError>}
                </Field>
              )}

              <Field data-invalid={!!errors.amount}>
                <FieldLabel htmlFor="safelock-amount">Amount to lock</FieldLabel>
                <NairaInput id="safelock-amount" value={v.amount} invalid={!!errors.amount} onChange={(x) => set("amount", x)} />
                {errors.amount ? (
                  <FieldError>{errors.amount}</FieldError>
                ) : (
                  <FieldDescription>
                    {branch?.availableKobo != null && (
                      <>
                        <span className="figure">{formatNaira(branch.availableKobo)}</span> available in {branch.name}.{" "}
                      </>
                    )}
                    At least <span className="figure">{formatNaira(limits.minAmountKobo)}</span>.
                  </FieldDescription>
                )}
              </Field>

              <FieldSet className="gap-3">
                <FieldLegend variant="label">Unlocks on</FieldLegend>
                {presets.length > 0 && (
                  <div role="radiogroup" aria-label="Lock for" className="flex flex-wrap gap-2">
                    {presets.map((d) => {
                      const day = addDays(today, d)
                      const checked = v.unlockOn === day
                      return (
                        <button
                          key={d}
                          type="button"
                          role="radio"
                          aria-checked={checked}
                          onClick={() => set("unlockOn", day)}
                          className={cn(
                            "h-8 rounded-full border px-3.5 text-sm transition-colors duration-150",
                            "focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                            checked ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted",
                          )}
                        >
                          {d === 365 ? "1 year" : `${d} days`}
                        </button>
                      )
                    })}
                  </div>
                )}
                <Field data-invalid={!!errors.unlockOn}>
                  <FieldLabel htmlFor="safelock-date" className="sr-only">
                    Unlock date
                  </FieldLabel>
                  <Input
                    id="safelock-date"
                    type="date"
                    min={limits.earliestUnlockOn}
                    max={limits.latestUnlockOn}
                    value={v.unlockOn}
                    aria-invalid={!!errors.unlockOn}
                    onChange={(e) => set("unlockOn", e.target.value)}
                    className="w-full sm:w-56"
                  />
                  {errors.unlockOn ? (
                    <FieldError>{errors.unlockOn}</FieldError>
                  ) : (
                    <FieldDescription>
                      {days !== null && days > 0
                        ? `Locked for ${days.toLocaleString("en-NG")} days. It unlocks at midnight at the start of that day.`
                        : `Between ${limits.minDays} and ${limits.maxDays.toLocaleString("en-NG")} days from today.`}
                    </FieldDescription>
                  )}
                </Field>
              </FieldSet>
            </form>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" form="safelock-form">
                Continue
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Lock {formatNaira(kobo!)}?</DialogTitle>
              <DialogDescription>Check the details. Once it&apos;s locked, nobody can undo it.</DialogDescription>
            </DialogHeader>
            <dl className="divide-y rounded-xl border text-sm">
              <ConfirmRow label="Name" value={v.title.trim()} />
              <ConfirmRow label="From" value={branch?.name} />
              <ConfirmRow label="Amount" value={<span className="type-display text-xl figure">{formatNaira(kobo!)}</span>} />
              <ConfirmRow
                label="Unlocks on"
                value={
                  <span className="grid justify-items-end">
                    <span>{formatDay(v.unlockOn)}</span>
                    <span className="text-xs text-muted-foreground">in {days!.toLocaleString("en-NG")} days</span>
                  </span>
                }
              />
            </dl>
            <div className="grid gap-3 rounded-xl bg-warning-subtle p-4 text-sm text-warning-foreground">
              <p className="flex items-start gap-2.5">
                <Lock className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span>
                  You can&apos;t take this money out, add to it or change the date before {formatDay(v.unlockOn)}, even in an
                  emergency. It doesn&apos;t earn interest.
                </span>
              </p>
              <Field orientation="horizontal">
                <Checkbox id="safelock-agree" checked={agreed} onCheckedChange={(c) => setAgreed(c === true)} />
                <FieldLabel htmlFor="safelock-agree" className="font-normal text-foreground">
                  I understand the money stays locked until {formatDay(v.unlockOn)}.
                </FieldLabel>
              </Field>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setStep("details")} disabled={busy}>
                Back
              </Button>
              <Button onClick={lock} disabled={!agreed || busy}>
                {busy ? <Spinner /> : <Lock data-icon="inline-start" aria-hidden />}
                Lock {formatNaira(kobo!)}
              </Button>
            </DialogFooter>
          </>
        )}
        {pin.dialog}
      </DialogContent>
    </Dialog>
  )
}

function ConfirmRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 px-4 py-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right break-words">{value}</dd>
    </div>
  )
}
