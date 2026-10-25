"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { BookUser, UserPlus, X } from "lucide-react"
import { toast } from "sonner"
import { createPayoutList, updatePayoutList } from "@/app/(dashboard)/payout-lists/actions"
import { FormError } from "@/components/common/form-error"
import { NairaInput } from "@/components/common/naira-input"
import { useTransactionPin } from "@/components/transaction-pin/use-transaction-pin"
import { useIdempotencyKey } from "@/hooks/use-idempotency-key"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { NativeSelect } from "@/components/ui/native-select"
import { Spinner } from "@/components/ui/spinner"
import type { Beneficiary, PayoutListWithItems } from "@/lib/api/types"
import { formatNaira } from "@/lib/format"
import { amountProblem, MAX_LIST_ROWS, MAX_LIST_TITLE, MAX_NARRATION, people, type BeneficiaryLike } from "@/lib/payouts"
import { formatNairaInput, koboToInput, parseNairaToKobo } from "@/lib/transfers"
import { cn } from "@/lib/utils"
import { BeneficiaryFormDialog } from "./beneficiary-form-dialog"
import { BeneficiaryPickerDialog } from "./beneficiary-picker-dialog"
import { BeneficiaryName } from "./parts"

/** A branch a list can pay from by default. */
export type ListBranch = { _id: string; name: string; accountNumber: string | null }

type Row = { key: string; beneficiary: BeneficiaryLike; amount: string; narration: string }

let nextKey = 0
const rowKey = () => `row-${++nextKey}`

const pick = (b: BeneficiaryLike): BeneficiaryLike => ({
  _id: b._id,
  accountName: b.accountName,
  nickname: b.nickname,
  accountNumber: b.accountNumber,
  bankName: b.bankName,
})

/**
 * Create or edit a payout list: a name, an optional default account, and rows of saved beneficiaries with an
 * amount and an optional narration each. People come from the address book (several at once) or as a new account,
 * which is checked with its bank and saved as a beneficiary. Saving takes the transaction PIN, because a list
 * decides who gets paid when it's run.
 */
export function PayoutListEditor({
  list,
  branches,
  defaultBranchId,
}: {
  list?: PayoutListWithItems
  branches: ListBranch[]
  /** A new list's account to start with (the branch picked in the sidebar). */
  defaultBranchId?: string
}) {
  const router = useRouter()
  const pin = useTransactionPin()
  // So saving a new list again after a dropped response doesn't save it twice.
  const idempotency = useIdempotencyKey()
  const editing = !!list
  const [title, setTitle] = useState(list?.title ?? "")
  const [branch, setBranch] = useState(list ? (list.branch?._id ?? "") : (defaultBranchId ?? ""))
  const [rows, setRows] = useState<Row[]>(() =>
    (list?.items ?? []).flatMap((i) =>
      i.beneficiary
        ? [{ key: rowKey(), beneficiary: pick(i.beneficiary), amount: formatNairaInput(koboToInput(i.amountKobo)), narration: i.narration ?? "" }]
        : [],
    ),
  )
  // Rows whose beneficiary has gone. They can't be paid, so saving leaves them out.
  const dropped = (list?.items ?? []).filter((i) => !i.beneficiary).length
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  const added = new Set(rows.map((r) => r.beneficiary._id))
  const totalKobo = rows.reduce((s, r) => s + (parseNairaToKobo(r.amount) ?? 0), 0)
  const room = MAX_LIST_ROWS - rows.length
  // The list's own branch stays choosable even if its account isn't in the member's ready accounts.
  const choices = list?.branch && !branches.some((b) => b._id === list.branch!._id) ? [{ ...list.branch, accountNumber: null }, ...branches] : branches

  function addPeople(picked: BeneficiaryLike[]) {
    const fresh = picked.filter((b) => !added.has(b._id)).slice(0, Math.max(0, room))
    if (!fresh.length) return
    setRows((prev) => [...prev, ...fresh.map((b) => ({ key: rowKey(), beneficiary: pick(b), amount: "", narration: "" }))])
    setErrors((prev) => ({ ...prev, rows: "" }))
  }

  function onSaved(b: Beneficiary, existed: boolean) {
    const name = b.nickname ?? b.accountName
    if (added.has(b._id)) return toast.info(`${name} is already on this list.`)
    if (room <= 0) return toast.error("This list already pays 200 people, the most one list can.")
    addPeople([b])
    toast.success(existed ? `${name} was already saved, and is now on the list.` : `${name} is saved as a beneficiary and added to the list.`)
  }

  const update = (key: string, patch: Partial<Row>) => setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  const remove = (key: string) => setRows((prev) => prev.filter((r) => r.key !== key))

  async function save(e: React.FormEvent) {
    e.preventDefault()
    // Forms in the dialogs (adding an account) sit in portals, but their submit events still bubble up here.
    if (e.target !== e.currentTarget) return
    const next: Record<string, string> = {}
    if (!title.trim()) next.title = "Give the list a name, like “Monthly salaries”."
    if (!rows.length) next.rows = "Add at least one person to pay."
    for (const r of rows) {
      const problem = amountProblem(r.amount)
      if (problem) next[r.key] = problem
    }
    setErrors(next)
    setError(undefined)
    if (Object.keys(next).length) return

    const items = rows.map((r) => ({ beneficiary: r.beneficiary._id, amountKobo: parseNairaToKobo(r.amount)!, narration: r.narration.trim() || undefined }))
    const name = title.trim()
    const created = { title: name, branch: branch || undefined, items }
    // Taken before the PIN dialog, which sends the same request again after a wrong PIN. Only a new list sends it:
    // an edit replaces the list, so sending it twice does no harm.
    const idempotencyKey = idempotency.keyFor(created)
    setBusy(true)
    const result = await pin.confirm({
      purpose: editing ? `save your changes to “${name}”` : `save “${name}”, paying ${people(items.length)} ${formatNaira(totalKobo)} in all`,
      confirmLabel: editing ? "Save changes" : "Save list",
      run: (transactionPin) =>
        editing
          ? updatePayoutList(list._id, { title: name, branch: branch || null, items }, transactionPin)
          : createPayoutList({ ...created, idempotencyKey }, transactionPin),
    })
    setBusy(false)
    if (!result) return
    if (!result.ok) {
      // The key was used for other details: let a deliberate retry be a new request.
      if (result.code === "IDEMPOTENCY_KEY_REUSED") idempotency.reset()
      // Field errors come back by path, e.g. "items.2.amountKobo" for the third row.
      const rowErrors: Record<string, string> = {}
      for (const [field, message] of Object.entries(result.fieldErrors ?? {})) {
        const match = /^items\.(\d+)\./.exec(field)
        const row = match && rows[Number(match[1])]
        if (row) rowErrors[row.key] = message
        else if (field === "title") rowErrors.title = message
      }
      setErrors(rowErrors)
      return setError(Object.keys(rowErrors).length ? "Check the highlighted rows." : result.error)
    }
    idempotency.reset()
    toast.success(editing ? "Changes saved." : `“${result.data.title}” is saved. Pay it whenever you're ready.`)
    router.push(`/payout-lists/${result.data._id}`)
  }

  return (
    <>
    <form onSubmit={save} noValidate className="grid min-w-0 gap-6">
      <FormError message={error} />

      <section className="surface grid gap-5 p-5 sm:p-7">
        <div className="grid gap-1">
          <h2 className="type-display text-xl">The list</h2>
          <p className="text-sm text-muted-foreground">Your team sees this name. Each payment is named after it and the date.</p>
        </div>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field data-invalid={!!errors.title}>
            <FieldLabel htmlFor="list-title">Name</FieldLabel>
            <Input
              id="list-title"
              maxLength={MAX_LIST_TITLE}
              autoComplete="off"
              placeholder="Monthly salaries"
              value={title}
              aria-invalid={!!errors.title}
              onChange={(e) => {
                setTitle(e.target.value)
                if (errors.title) setErrors((prev) => ({ ...prev, title: "" }))
              }}
            />
            {errors.title && <FieldError>{errors.title}</FieldError>}
          </Field>
          <Field>
            <FieldLabel htmlFor="list-branch">Pay from</FieldLabel>
            <NativeSelect id="list-branch" value={branch} onChange={(e) => setBranch(e.target.value)}>
              <option value="">Choose each time</option>
              {choices.map((b) => (
                <option key={b._id} value={b._id}>
                  {b.name}
                  {b.accountNumber ? ` · ${b.accountNumber}` : ""}
                </option>
              ))}
            </NativeSelect>
            <FieldDescription>The account it pays from by default. You can pick another when you pay.</FieldDescription>
          </Field>
        </div>
      </section>

      <section className="surface grid gap-0 overflow-hidden" aria-labelledby="list-people">
        <div className="flex flex-wrap items-end justify-between gap-4 p-5 sm:p-7">
          <div className="grid gap-1">
            <h2 id="list-people" className="type-display text-xl">
              People to pay
            </h2>
            <p className="text-sm text-muted-foreground">
              {rows.length ? (
                <>
                  {people(rows.length)}, <span className="figure font-medium text-foreground">{formatNaira(totalKobo)}</span> before fees. Fees are
                  worked out when you pay.
                </>
              ) : (
                "Add saved beneficiaries, or a new account. New accounts are checked with their bank and saved for next time."
              )}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <BeneficiaryFormDialog
              onSaved={onSaved}
              title="Add a new account"
              description="We check the account with its bank, save it as a beneficiary for your whole team and add it to this list."
              submitLabel="Save and add"
            >
              {/* Saves a beneficiary straight away (and checks the account with a POST), so it's a write. */}
              <Button write type="button" variant="outline" disabled={room <= 0}>
                <UserPlus data-icon="inline-start" aria-hidden />
                Add a new account
              </Button>
            </BeneficiaryFormDialog>
            <BeneficiaryPickerDialog added={added} room={room} onAdd={addPeople}>
              <Button type="button" disabled={room <= 0}>
                <BookUser data-icon="inline-start" aria-hidden />
                Add from beneficiaries
              </Button>
            </BeneficiaryPickerDialog>
          </div>
        </div>

        {dropped > 0 && (
          <p className="mx-5 mb-4 rounded-lg bg-warning-subtle px-3 py-2.5 text-sm text-warning-foreground sm:mx-7">
            {dropped === 1 ? "1 person on this list is" : `${dropped} people on this list are`} no longer saved as a beneficiary, so they&apos;re left out. Saving keeps the list without them.
          </p>
        )}
        {errors.rows && <p className="mx-5 mb-4 text-sm text-destructive sm:mx-7">{errors.rows}</p>}

        {rows.length > 0 && (
          <div className="border-t">
            <div className="hidden grid-cols-[minmax(0,1fr)_minmax(0,14rem)_11rem_2.25rem] gap-4 bg-muted/60 px-7 py-2.5 text-xs font-medium text-muted-foreground md:grid">
              <span>Beneficiary</span>
              <span>Narration (optional)</span>
              <span className="text-right">Amount</span>
              <span>
                <span className="sr-only">Remove</span>
              </span>
            </div>
            <ul className="divide-y">
              {rows.map((r, i) => {
                const problem = errors[r.key]
                const label = r.beneficiary.nickname ?? r.beneficiary.accountName
                return (
                  <li
                    key={r.key}
                    className={cn(
                      "grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-3 px-5 py-4 sm:px-7 md:grid-cols-[minmax(0,1fr)_minmax(0,14rem)_11rem_2.25rem] md:items-center",
                      problem && "bg-destructive/5",
                    )}
                  >
                    <BeneficiaryName beneficiary={r.beneficiary} />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="md:order-last"
                      aria-label={`Remove ${label} from the list`}
                      onClick={() => remove(r.key)}
                    >
                      <X aria-hidden />
                    </Button>
                    <div className="col-span-2 grid gap-3 sm:grid-cols-2 md:col-span-2 md:grid-cols-[minmax(0,14rem)_11rem] md:gap-4">
                      <Input
                        aria-label={`Narration for ${label}`}
                        maxLength={MAX_NARRATION}
                        placeholder="Narration (optional)"
                        value={r.narration}
                        onChange={(e) => update(r.key, { narration: e.target.value })}
                      />
                      <div className="grid gap-1">
                        <NairaInput
                          id={`row-amount-${i}`}
                          aria-label={`Amount for ${label}`}
                          value={r.amount}
                          invalid={!!problem}
                          className="text-right"
                          onChange={(amount) => {
                            update(r.key, { amount })
                            if (problem) setErrors((prev) => ({ ...prev, [r.key]: "" }))
                          }}
                        />
                        {problem && <span className="text-xs text-destructive">{problem}</span>}
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          </div>
        )}
      </section>

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button type="button" variant="ghost" asChild>
          <Link href={editing ? `/payout-lists/${list._id}` : "/payout-lists"}>Cancel</Link>
        </Button>
        {/* Also reached straight from its URL, so gated here as well as at the links to it. */}
        <Button write type="submit" disabled={busy}>
          {busy && <Spinner />}
          {editing ? "Save changes" : "Save list"}
        </Button>
      </div>
    </form>
    {pin.dialog}
    </>
  )
}
