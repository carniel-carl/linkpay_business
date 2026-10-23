"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { ListChecks, ListPlus } from "lucide-react"
import { toast } from "sonner"
import { savePayoutListFromBatch } from "@/app/(dashboard)/payout-lists/actions"
import { FormError } from "@/components/common/form-error"
import { useTransactionPin } from "@/components/transaction-pin/use-transaction-pin"
import { useIdempotencyKey } from "@/hooks/use-idempotency-key"
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
import { Field, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import type { TransferBatch } from "@/lib/api/types"
import { MAX_LIST_TITLE } from "@/lib/payouts"

/**
 * On a bulk transfer: "Save as a list" (POST /api/payout-lists with `fromBatch`), which also saves its bank recipients
 * as beneficiaries. A batch that a list ran links back to that list instead. Saving a list takes the PIN.
 */
export function BatchListAction({ batch }: { batch: TransferBatch & { payoutList?: string | null } }) {
  if (batch.payoutList) {
    return (
      <Button variant="ghost" size="sm" asChild>
        <Link href={`/payout-lists/${batch.payoutList}`}>
          <ListChecks data-icon="inline-start" aria-hidden />
          Open its payout list
        </Link>
      </Button>
    )
  }
  return <SaveBatchAsListDialog batch={batch} />
}

function SaveBatchAsListDialog({ batch }: { batch: TransferBatch }) {
  const router = useRouter()
  const pin = useTransactionPin()
  // So saving again after a dropped response doesn't save the list twice.
  const idempotency = useIdempotencyKey()
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState(batch.title ?? "")
  const [invalid, setInvalid] = useState<string>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  async function save(e: React.FormEvent) {
    e.preventDefault()
    e.stopPropagation()
    const name = title.trim()
    if (!name) return setInvalid("Give the list a name, like “Monthly salaries”.")
    setInvalid(undefined)
    setError(undefined)
    const request = { title: name, fromBatch: batch._id }
    const idempotencyKey = idempotency.keyFor(request)
    setBusy(true)
    const result = await pin.confirm({
      purpose: `save this bulk transfer as the payout list “${name}”`,
      confirmLabel: "Save list",
      run: (transactionPin) => savePayoutListFromBatch({ ...request, idempotencyKey }, transactionPin),
    })
    setBusy(false)
    if (!result) return
    if (!result.ok) {
      if (result.code === "IDEMPOTENCY_KEY_REUSED") idempotency.reset()
      return setError(result.error)
    }
    idempotency.reset()
    toast.success(`“${result.data.title}” is saved with ${result.data.count === 1 ? "1 person" : `${result.data.count} people`}.`)
    setOpen(false)
    router.push(`/payout-lists/${result.data._id}`)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return
        setOpen(next)
        if (next) {
          setTitle(batch.title ?? "")
          setInvalid(undefined)
          setError(undefined)
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline">
          <ListPlus data-icon="inline-start" aria-hidden />
          Save as a list
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Save as a payout list</DialogTitle>
          <DialogDescription>
            Pay the same people the same amounts again later, changing anything you need to. Anyone in it who isn&apos;t saved yet is added to your
            beneficiaries. Transfers to your own branches are left out.
          </DialogDescription>
        </DialogHeader>
        <FormError message={error} />
        <form id="batch-list-form" onSubmit={save} noValidate>
          <Field data-invalid={!!invalid}>
            <FieldLabel htmlFor="batch-list-title">Name</FieldLabel>
            <Input
              id="batch-list-title"
              maxLength={MAX_LIST_TITLE}
              autoComplete="off"
              placeholder="Monthly salaries"
              value={title}
              aria-invalid={!!invalid}
              onChange={(e) => setTitle(e.target.value)}
            />
            {invalid && <FieldError>{invalid}</FieldError>}
          </Field>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form="batch-list-form" disabled={busy}>
            {busy && <Spinner />}
            Save list
          </Button>
        </DialogFooter>
        {pin.dialog}
      </DialogContent>
    </Dialog>
  )
}
