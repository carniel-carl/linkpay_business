"use client"

import { useState } from "react"
import Link from "next/link"
import { ShieldAlert } from "lucide-react"
import { toast } from "sonner"
import { addSettlementAccount, checkSettlementAccount } from "@/app/(dashboard)/settings/money-protection/actions"
import { listBanks } from "@/app/(dashboard)/transfers/actions"
import { PasswordInput } from "@/components/auth/password-input"
import { FormError } from "@/components/common/form-error"
import { useStepUp } from "@/components/security/step-up-dialog"
import { BankPicker } from "@/components/transfers/new-transfer-dialog"
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
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import type { Bank, SettlementCheck } from "@/lib/api/types"

type Props = {
  /** Two-step verification must be on before an account can be added. */
  twoFactorOn: boolean
  coolingOffHours: number
  children: React.ReactNode
}

/**
 * Adds a settlement account: the bank checks whose it is, the owner types their password again and
 * confirms with a code. LinkPay then reviews it and it can't be used before the cooling-off ends.
 */
export function AddSettlementDialog({ twoFactorOn, coolingOffHours, children }: Props) {
  const [open, setOpen] = useState(false)
  const [banks, setBanks] = useState<Bank[] | null>(null)
  const [bankUuid, setBankUuid] = useState("")
  const [accountNumber, setAccountNumber] = useState("")
  const [checked, setChecked] = useState<SettlementCheck | null>(null)
  const [password, setPassword] = useState("")
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState<"check" | "add" | null>(null)
  const stepUp = useStepUp()

  function reset() {
    setBankUuid("")
    setAccountNumber("")
    setChecked(null)
    setPassword("")
    setErrors({})
    setError(undefined)
  }

  async function onOpen(next: boolean) {
    setOpen(next)
    if (!next) return reset()
    if (!banks) {
      const result = await listBanks()
      if (result.ok) setBanks(result.data)
      else setError(result.error)
    }
  }

  async function check() {
    const next: Record<string, string> = {}
    if (!bankUuid) next.bank = "Choose the bank."
    if (!/^\d{10}$/.test(accountNumber)) next.accountNumber = "Account numbers are 10 digits."
    setErrors(next)
    if (Object.keys(next).length) return
    setBusy("check")
    setError(undefined)
    const result = await checkSettlementAccount({ accountNumber, bankUuid })
    setBusy(null)
    if (!result.ok) return setError(result.error)
    setChecked(result.data)
  }

  async function add() {
    if (!checked) return
    if (!password) return setErrors({ password: "Type your password." })
    setBusy("add")
    setError(undefined)
    setErrors({})
    const account = { accountNumber: checked.accountNumber, bankUuid }
    const result = await stepUp.confirm("settlement.add", account, (proof) => addSettlementAccount({ ...account, password }, proof))
    setBusy(null)
    if (!result) return
    if (!result.ok) {
      if (result.code === "INCORRECT_PASSWORD") return setErrors({ password: result.error })
      return setError(result.error)
    }
    toast.success(`${checked.accountName} was added. LinkPay will check it, and you can withdraw to it once it's approved.`)
    setOpen(false)
    reset()
  }

  return (
    <Dialog open={open} onOpenChange={onOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a settlement account</DialogTitle>
          <DialogDescription>
            Your business&apos;s own account at another bank, where you&apos;ll withdraw money to. It must be in your
            business&apos;s name.
          </DialogDescription>
        </DialogHeader>

        {!twoFactorOn ? (
          <div className="flex gap-3 rounded-xl bg-warning-subtle p-4 text-sm text-warning-foreground">
            <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            <p>
              Turn on two-step verification first, so nobody with only your password can add an account.{" "}
              <Link href="/settings/security" className="font-medium underline underline-offset-4">
                Set it up
              </Link>
              . Money can&apos;t leave for 24 hours after you change it.
            </p>
          </div>
        ) : (
          <div className="grid gap-5">
            <Field data-invalid={!!errors.bank || undefined}>
              <FieldLabel htmlFor="settlement-bank">Bank</FieldLabel>
              <BankPicker
                id="settlement-bank"
                banks={banks}
                value={bankUuid}
                onChange={(uuid) => {
                  setBankUuid(uuid)
                  setChecked(null)
                }}
                invalid={!!errors.bank}
              />
              <FieldError>{errors.bank}</FieldError>
            </Field>
            <Field data-invalid={!!errors.accountNumber || undefined}>
              <FieldLabel htmlFor="settlement-number">Account number</FieldLabel>
              <Input
                id="settlement-number"
                inputMode="numeric"
                maxLength={10}
                className="font-mono"
                value={accountNumber}
                aria-invalid={!!errors.accountNumber || undefined}
                onChange={(e) => {
                  setAccountNumber(e.target.value.replace(/\D/g, ""))
                  setChecked(null)
                }}
              />
              <FieldError>{errors.accountNumber}</FieldError>
            </Field>

            {checked && (
              <div className="grid gap-2 rounded-xl bg-muted px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium">{checked.accountName}</span>
                  {checked.nameCheck.result === "match" ? (
                    <Badge variant="success">Name matches</Badge>
                  ) : (
                    <Badge variant="warning">Partly matches</Badge>
                  )}
                </div>
                <p className="text-sm text-muted-foreground">
                  <span className="font-mono">{checked.accountNumber}</span>, {checked.bankName ?? "bank"}
                </p>
                {checked.nameCheck.result === "partial" && (
                  <p className="text-sm text-muted-foreground">
                    The name only partly matches {checked.nameCheck.matchedName}, so LinkPay will look at it more closely.
                  </p>
                )}
              </div>
            )}

            {checked && (
              <Field data-invalid={!!errors.password || undefined}>
                <FieldLabel htmlFor="settlement-password">Your password</FieldLabel>
                <PasswordInput
                  id="settlement-password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  aria-invalid={!!errors.password || undefined}
                />
                <FieldDescription>
                  Next we&apos;ll ask for a code. LinkPay then checks the account and may call you on a number from your
                  verification. It can&apos;t be used for {coolingOffHours} hours, and your team is emailed about it.
                </FieldDescription>
                <FieldError>{errors.password}</FieldError>
              </Field>
            )}

            <FormError message={error} />
          </div>
        )}

        <DialogFooter>
          {!twoFactorOn ? (
            <Button variant="outline" onClick={() => onOpen(false)}>
              Close
            </Button>
          ) : checked ? (
            <Button onClick={add} disabled={busy !== null}>
              {busy === "add" && <Spinner />}
              Add account
            </Button>
          ) : (
            <Button onClick={check} disabled={busy !== null}>
              {busy === "check" && <Spinner />}
              Check account
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
      {stepUp.dialog}
    </Dialog>
  )
}
