"use client"

import { useEffect, useState } from "react"
import { UserPlus } from "lucide-react"
import { toast } from "sonner"
import { createBeneficiary } from "@/app/(dashboard)/beneficiaries/actions"
import { listBanks, resolveAccount } from "@/app/(dashboard)/transfers/actions"
import { FormError } from "@/components/common/form-error"
import { BankPicker, ResolvedName } from "@/components/transfers/new-transfer-dialog"
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
import type { Bank, Beneficiary, ResolvedAccount } from "@/lib/api/types"
import { MAX_NICKNAME } from "@/lib/payouts"

/**
 * Save an account as a beneficiary: bank and account number, with the account name shown as the digits land (as in
 * New transfer), and an optional nickname. The API checks the account with the bank again when it saves it.
 * `onSaved` gets the beneficiary, or the one already saved for that account (`existed`).
 */
export function BeneficiaryFormDialog({
  children,
  onSaved,
  title = "Add beneficiary",
  description = "We check the account with its bank and save the name it gives. Everyone on your team can then pay them without checking again.",
  submitLabel = "Save beneficiary",
}: {
  children: React.ReactNode
  onSaved?: (beneficiary: Beneficiary, existed: boolean) => void
  title?: string
  description?: string
  submitLabel?: string
}) {
  const [open, setOpen] = useState(false)
  const [banks, setBanks] = useState<Bank[] | null>(null)
  const [bankUuid, setBankUuid] = useState("")
  const [accountNumber, setAccountNumber] = useState("")
  const [nickname, setNickname] = useState("")
  // The latest name enquiry, keyed by "bank:account number" so a stale answer never shows.
  const [lookup, setLookup] = useState<{ key: string; data?: ResolvedAccount; error?: string } | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  const lookupKey = bankUuid && /^\d{10}$/.test(accountNumber) ? `${bankUuid}:${accountNumber}` : null
  const current = lookup && lookup.key === lookupKey ? lookup : null
  const resolved = current?.data ?? null
  const resolving = !!lookupKey && !current
  // The business's own branches are paid as branches, never saved (BENEFICIARY_OWN_ACCOUNT).
  const ownBranch = resolved?.kind === "internal"
  const resolveError = current?.error ?? (ownBranch ? "This is one of your own branches. Move money to it as a branch transfer instead." : undefined)

  function reset() {
    setBankUuid("")
    setAccountNumber("")
    setNickname("")
    setLookup(null)
    setErrors({})
    setError(undefined)
  }

  useEffect(() => {
    if (!open || banks) return
    listBanks().then((r) => (r.ok ? setBanks(r.data) : setError(r.error)))
  }, [open, banks])

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

  async function save(e: React.FormEvent) {
    e.preventDefault()
    // The dialog is in a portal, but React still bubbles its submit to any form it was opened from.
    e.stopPropagation()
    const next: Record<string, string> = {}
    if (!bankUuid) next.bank = "Choose the bank."
    if (!/^\d{10}$/.test(accountNumber)) next.accountNumber = "Account numbers are 10 digits."
    else if (!resolved && !resolveError) next.accountNumber = "Wait for the account name to show."
    setErrors(next)
    if (Object.keys(next).length || resolveError) return

    setBusy(true)
    setError(undefined)
    const result = await createBeneficiary({ accountNumber, bankUuid, nickname: nickname.trim() || undefined })
    setBusy(false)
    if (!result.ok) {
      if (result.code === "ACCOUNT_NOT_FOUND" || result.code === "BENEFICIARY_OWN_ACCOUNT") return setErrors({ accountNumber: result.error })
      if (result.fieldErrors?.nickname) return setErrors({ nickname: result.fieldErrors.nickname })
      return setError(result.error)
    }
    const { beneficiary, existed } = result.data
    const name = beneficiary.nickname ?? beneficiary.accountName
    if (onSaved) onSaved(beneficiary, existed)
    else toast.success(existed ? `This account is already saved, as ${name}.` : `${name} is saved.`)
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
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <FormError message={error} />
        <form id="beneficiary-form" onSubmit={save} noValidate className="grid gap-5">
          <Field data-invalid={!!errors.bank}>
            <FieldLabel htmlFor="beneficiary-bank">Bank</FieldLabel>
            <BankPicker id="beneficiary-bank" banks={banks} value={bankUuid} onChange={setBankUuid} invalid={!!errors.bank} />
            {errors.bank && <FieldError>{errors.bank}</FieldError>}
          </Field>
          <Field data-invalid={!!errors.accountNumber || !!resolveError}>
            <FieldLabel htmlFor="beneficiary-account">Account number</FieldLabel>
            <Input
              id="beneficiary-account"
              inputMode="numeric"
              autoComplete="off"
              maxLength={10}
              className="font-mono tracking-[0.04em]"
              value={accountNumber}
              aria-invalid={!!errors.accountNumber || !!resolveError}
              onChange={(e) => setAccountNumber(e.target.value.replace(/\D/g, "").slice(0, 10))}
            />
            <p role="status" aria-live="polite" className="min-h-5 text-sm">
              {resolving ? (
                <span className="inline-flex items-center gap-2 text-muted-foreground">
                  <Spinner /> Checking the account
                </span>
              ) : resolveError ? (
                <span className="text-destructive">{resolveError}</span>
              ) : resolved ? (
                <ResolvedName account={resolved} />
              ) : null}
            </p>
            {errors.accountNumber && !resolveError && <FieldError>{errors.accountNumber}</FieldError>}
          </Field>
          <Field data-invalid={!!errors.nickname}>
            <FieldLabel htmlFor="beneficiary-nickname">Nickname (optional)</FieldLabel>
            <Input
              id="beneficiary-nickname"
              maxLength={MAX_NICKNAME}
              autoComplete="off"
              placeholder="Ada, cashier"
              value={nickname}
              aria-invalid={!!errors.nickname}
              onChange={(e) => setNickname(e.target.value)}
            />
            {errors.nickname ? (
              <FieldError>{errors.nickname}</FieldError>
            ) : (
              <FieldDescription>Only your team sees this. Payments carry the bank&apos;s name.</FieldDescription>
            )}
          </Field>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form="beneficiary-form" disabled={busy || resolving || !!resolveError}>
            {busy ? <Spinner /> : <UserPlus data-icon="inline-start" aria-hidden />}
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
