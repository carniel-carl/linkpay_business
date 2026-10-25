"use client"

import { useEffect, useState } from "react"
import { ArrowDownLeft, ArrowUpRight, Archive, Pencil, Plus, Zap } from "lucide-react"
import { toast } from "sonner"
import { closePocket, getPocketActivity, movePocketMoney } from "@/app/(dashboard)/savings/actions"
import { FormError } from "@/components/common/form-error"
import { NairaInput } from "@/components/common/naira-input"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { WriteGate } from "@/components/shell/write-gate"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { useTransactionPin } from "@/components/transaction-pin/use-transaction-pin"
import { useIdempotencyKey } from "@/hooks/use-idempotency-key"
import type { Pocket, PocketMovement } from "@/lib/api/types"
import { formatDate, formatDateTime, formatNaira } from "@/lib/format"
import { describeAutoSave, formatDay, MOVEMENT_LABELS } from "@/lib/savings"
import { koboToInput, parseNairaToKobo } from "@/lib/transfers"
import { cn } from "@/lib/utils"
import { PocketFormDialog, type PocketBranch } from "./pocket-form-dialog"
import { PocketProgress, PocketTags, PocketTile, TargetLine } from "./parts"

type Props = {
  pocket: Pocket | null
  /** What the pocket's branch can still save (its available balance), when known. */
  availableKobo: number | null
  branches: PocketBranch[]
  onClose: () => void
}

type IdempotencyKey = ReturnType<typeof useIdempotencyKey>

/** One pocket: balance, target, rule, add and withdraw, edit, close and its history. */
export function PocketSheet({ pocket, availableKobo, branches, onClose }: Props) {
  // Here rather than in the form, so it outlives the sheet: adding the same amount again after closing it (a move
  // whose answer was lost) keeps the key and moves the money once.
  const idempotency = useIdempotencyKey()
  return (
    <Sheet open={!!pocket} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="gap-0 overflow-y-auto p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-md">
        {pocket && (
          <Details key={pocket._id} pocket={pocket} availableKobo={availableKobo} branches={branches} idempotency={idempotency} onClosed={onClose} />
        )}
      </SheetContent>
    </Sheet>
  )
}

function Details({
  pocket: p,
  availableKobo,
  branches,
  idempotency,
  onClosed,
}: {
  pocket: Pocket
  availableKobo: number | null
  branches: PocketBranch[]
  idempotency: IdempotencyKey
  onClosed: () => void
}) {
  const [mode, setMode] = useState<"deposit" | "withdraw" | null>(null)
  const autoSave = describeAutoSave(p.autoSave)

  return (
    <>
      <SheetHeader className="gap-5 border-b bg-muted/50 p-6 pr-14">
        <div className="flex items-center gap-3">
          <PocketTile icon={p.icon} color={p.color} />
          <PocketTags pocket={p} />
        </div>
        <div className="grid gap-1.5">
          <SheetDescription className="text-foreground">
            <span className="font-display text-lg font-semibold tracking-[-0.02em]">{p.name}</span>
            {p.branch && <span className="text-muted-foreground">, {p.branch.name}</span>}
          </SheetDescription>
          <SheetTitle className="type-display text-4xl font-normal figure">
            <span className="sr-only">{p.name} balance: </span>
            {formatNaira(p.balanceKobo)}
          </SheetTitle>
        </div>
        {p.target && p.status === "active" && (
          <div className="grid gap-2">
            <PocketProgress bps={p.target.progressBps} color={p.color} className="h-2" />
            <TargetLine pocket={p} />
          </div>
        )}
        {p.canManage && !mode && (
          // Disabled, with the reason, while the business is suspended.
          <WriteGate>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => setMode("deposit")}>
                <Plus data-icon="inline-start" aria-hidden />
                Add money
              </Button>
              <Button variant="outline" onClick={() => setMode("withdraw")} disabled={p.balanceKobo === 0}>
                <ArrowUpRight data-icon="inline-start" aria-hidden />
                Withdraw
              </Button>
            </div>
          </WriteGate>
        )}
      </SheetHeader>

      {mode && (
        <MoveForm
          key={mode}
          pocket={p}
          mode={mode}
          limitKobo={mode === "deposit" ? availableKobo : p.balanceKobo}
          idempotency={idempotency}
          onDone={() => setMode(null)}
        />
      )}

      <dl className="grid gap-4 border-b p-6 text-sm">
        <Row label="Target">
          {p.target ? (
            <>
              <span className="figure">{formatNaira(p.target.amountKobo)}</span>
              {p.target.date && <span className="text-muted-foreground"> by {formatDay(p.target.date)}</span>}
            </>
          ) : (
            <span className="text-muted-foreground">None</span>
          )}
        </Row>
        <Row label="Auto-save">
          {autoSave && p.status === "active" ? (
            <span className="grid justify-items-end">
              <span>{autoSave}</span>
              <span className="text-xs text-muted-foreground">
                Since {formatDate(p.autoSave!.since)}
                {p.target ? ", until the target is reached" : ""}
              </span>
            </span>
          ) : (
            <span className="text-muted-foreground">Off</span>
          )}
        </Row>
        {p.branch && <Row label="Branch">{p.branch.name}</Row>}
        <Row label="Opened">
          {formatDate(p.createdAt)}
          {p.createdBy && <span className="text-muted-foreground"> by {p.createdBy.name}</span>}
        </Row>
        {p.closedAt && <Row label="Closed">{formatDate(p.closedAt)}</Row>}
      </dl>

      {p.canManage && (
        <div className="border-b px-6 py-4">
          <WriteGate>
            <div className="flex flex-wrap gap-2">
              <PocketFormDialog pocket={p} branches={branches}>
                <Button variant="ghost" size="sm">
                  <Pencil data-icon="inline-start" aria-hidden />
                  Edit
                </Button>
              </PocketFormDialog>
              <ClosePocket pocket={p} onClosed={onClosed} />
            </div>
          </WriteGate>
        </div>
      )}

      <Activity pocket={p} />
    </>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-6">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right break-words">{children}</dd>
    </div>
  )
}

/** Inline amount form for adding to or withdrawing from the pocket. */
function MoveForm({
  pocket,
  mode,
  limitKobo,
  idempotency,
  onDone,
}: {
  pocket: Pocket
  mode: "deposit" | "withdraw"
  /** The most that can move: the branch's available balance, or the pocket's balance. */
  limitKobo: number | null
  /** The sheet's, so it outlives this form. */
  idempotency: IdempotencyKey
  onDone: () => void
}) {
  const [amount, setAmount] = useState("")
  const [note, setNote] = useState("")
  const pin = useTransactionPin()
  const [fieldError, setFieldError] = useState<string>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const deposit = mode === "deposit"
  const branch = pocket.branch?.name ?? "the branch"

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const kobo = parseNairaToKobo(amount)
    if (kobo === null || kobo < 100) return setFieldError("Enter an amount of at least ₦1.")
    if (limitKobo !== null && kobo > limitKobo) {
      return setFieldError(
        deposit ? `${branch} has ${formatNaira(limitKobo)} available.` : `This pocket has ${formatNaira(limitKobo)}.`,
      )
    }
    setFieldError(undefined)
    setBusy(true)
    setError(undefined)
    const request = { amountKobo: kobo, note: note.trim() || undefined }
    // A retry with the same amount and note keeps the key, whatever went wrong (a wrong PIN included); a corrected
    // request gets a new one. The pocket, the direction, the amount and the note are what the API compares a repeat with.
    const idempotencyKey = idempotency.keyFor({ pocket: pocket._id, mode, ...request })
    // Adding money doesn't take the PIN; withdrawing does.
    const result = deposit
      ? await movePocketMoney(pocket._id, "deposit", { ...request, idempotencyKey })
      : await pin.confirm({
          purpose: `withdraw ${formatNaira(kobo)} from ${pocket.name} to ${branch}`,
          confirmLabel: `Withdraw ${formatNaira(kobo)}`,
          run: (transactionPin) => movePocketMoney(pocket._id, "withdraw", { ...request, idempotencyKey }, transactionPin),
        })
    setBusy(false)
    if (!result) return
    if (!result.ok) {
      // The key was used for other details: let a deliberate retry be a new request.
      if (result.code === "IDEMPOTENCY_KEY_REUSED") idempotency.reset()
      return setError(result.error)
    }
    idempotency.reset()
    toast.success(
      deposit
        ? `${formatNaira(kobo)} added to ${pocket.name}.`
        : `${formatNaira(kobo)} moved back to ${branch}'s available balance.`,
    )
    onDone()
  }

  return (
    <>
      <form onSubmit={submit} noValidate className="grid gap-4 border-b bg-card p-6" aria-label={deposit ? "Add money" : "Withdraw"}>
        <p className="font-medium">{deposit ? `Add money from ${branch}` : `Withdraw to ${branch}`}</p>
        <FormError message={error} />
        <Field data-invalid={!!fieldError}>
          <FieldLabel htmlFor="pocket-move-amount">Amount</FieldLabel>
          <NairaInput id="pocket-move-amount" value={amount} invalid={!!fieldError} onChange={setAmount} autoFocus />
          {fieldError ? (
            <FieldError>{fieldError}</FieldError>
          ) : (
            limitKobo !== null && (
              <FieldDescription className="flex flex-wrap items-center gap-x-2">
                <span>
                  <span className="figure">{formatNaira(limitKobo)}</span> {deposit ? `available in ${branch}` : "in this pocket"}
                </span>
                {limitKobo >= 100 && (
                  <button
                    type="button"
                    className="rounded-sm font-medium text-foreground underline-offset-4 hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                    onClick={() => setAmount(koboToInput(limitKobo))}
                  >
                    Use all
                  </button>
                )}
              </FieldDescription>
            )
          )}
        </Field>
        <Field>
          <FieldLabel htmlFor="pocket-move-note">Note (optional)</FieldLabel>
          <Input id="pocket-move-note" maxLength={100} value={note} onChange={(e) => setNote(e.target.value)} placeholder={deposit ? "October VAT" : "Paid the generator deposit"} />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy}>
            {busy && <Spinner />}
            {deposit ? "Add money" : "Withdraw"}
          </Button>
          <Button type="button" variant="ghost" onClick={onDone} disabled={busy}>
            Cancel
          </Button>
        </div>
      </form>
      {/* Outside the form: React passes events up through portals, and the dialog has forms of its own. */}
      {pin.dialog}
    </>
  )
}

function ClosePocket({ pocket, onClosed }: { pocket: Pocket; onClosed: () => void }) {
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const pin = useTransactionPin()
  const branch = pocket.branch?.name ?? "the branch"

  async function close() {
    setPending(true)
    setError(undefined)
    const result = await pin.confirm({
      purpose:
        pocket.balanceKobo > 0
          ? `close ${pocket.name} and move ${formatNaira(pocket.balanceKobo)} back to ${branch}`
          : `close ${pocket.name}`,
      confirmLabel: "Close pocket",
      run: (transactionPin) => closePocket(pocket._id, transactionPin),
    })
    setPending(false)
    if (!result) return
    if (!result.ok) return setError(result.error)
    setOpen(false)
    toast.success(
      pocket.balanceKobo > 0
        ? `${pocket.name} is closed. ${formatNaira(pocket.balanceKobo)} is back in ${branch}'s available balance.`
        : `${pocket.name} is closed.`,
    )
    onClosed()
  }

  return (
    <AlertDialog open={open} onOpenChange={(next) => !pending && setOpen(next)}>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive">
          <Archive data-icon="inline-start" aria-hidden />
          Close pocket
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Close {pocket.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {pocket.balanceKobo > 0 ? (
              <>
                <span className="figure">{formatNaira(pocket.balanceKobo)}</span> goes back to {branch}&apos;s available balance.{" "}
              </>
            ) : null}
            Auto-save stops. The pocket and its history stay under Closed.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <FormError message={error} />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Keep it</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={pending}
            onClick={(e) => {
              e.preventDefault()
              close()
            }}
          >
            {pending && <Spinner />}
            Close pocket
          </AlertDialogAction>
        </AlertDialogFooter>
        {pin.dialog}
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** Movements, newest first. Reloads when the balance changes (a move here, or auto-save in the background). */
function Activity({ pocket }: { pocket: Pocket }) {
  const [items, setItems] = useState<PocketMovement[] | null>(null)
  const [next, setNext] = useState<string | null>(null)
  const [error, setError] = useState<string>()
  const [loadingMore, setLoadingMore] = useState(false)
  const version = `${pocket.balanceKobo}:${pocket.status}`

  useEffect(() => {
    let stale = false
    getPocketActivity(pocket._id).then((r) => {
      if (stale) return
      if (!r.ok) return setError(r.error)
      setError(undefined)
      setItems(r.data.items)
      setNext(r.data.nextBefore)
    })
    return () => {
      stale = true
    }
  }, [pocket._id, version])

  async function more() {
    if (!next) return
    setLoadingMore(true)
    const r = await getPocketActivity(pocket._id, next)
    setLoadingMore(false)
    if (!r.ok) return toast.error(r.error)
    setItems((prev) => [...(prev ?? []), ...r.data.items])
    setNext(r.data.nextBefore)
  }

  return (
    <section aria-labelledby="pocket-activity" className="grid gap-3 p-6">
      <h3 id="pocket-activity" className="text-sm font-medium">
        Activity
      </h3>
      {error && !items ? (
        <p className="text-sm text-muted-foreground">{error}</p>
      ) : !items ? (
        <div className="grid gap-3" aria-busy aria-label="Loading activity">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="flex items-center gap-3">
              <Skeleton className="size-8 rounded-[10px]" />
              <div className="grid flex-1 gap-1.5">
                <Skeleton className="h-3.5 w-28" />
                <Skeleton className="h-3 w-40" />
              </div>
              <Skeleton className="h-4 w-20" />
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing yet. Money added, withdrawn or auto-saved shows here.</p>
      ) : (
        <>
          <ul className="divide-y">
            {items.map((m) => (
              <MovementRow key={m._id} movement={m} />
            ))}
          </ul>
          {next && (
            <Button variant="outline" size="sm" className="w-fit" onClick={more} disabled={loadingMore}>
              {loadingMore && <Spinner />}
              Show older
            </Button>
          )}
        </>
      )}
    </section>
  )
}

function MovementRow({ movement: m }: { movement: PocketMovement }) {
  const Icon = m.kind === "auto_save" ? Zap : m.direction === "in" ? ArrowDownLeft : ArrowUpRight
  const who = m.kind === "auto_save" ? "From a payment in" : m.createdBy?.name
  return (
    <li className="flex items-center gap-3 py-3">
      <span
        className={cn(
          "grid size-8 shrink-0 place-items-center rounded-[10px]",
          m.direction === "in" ? "bg-success-subtle text-success" : "bg-muted text-muted-foreground",
        )}
      >
        <Icon className="size-4" aria-hidden />
      </span>
      <div className="grid min-w-0 flex-1">
        <span className="truncate text-sm font-medium">{m.note || MOVEMENT_LABELS[m.kind]}</span>
        <span className="truncate text-xs text-muted-foreground">
          {[m.note ? MOVEMENT_LABELS[m.kind] : null, who, formatDateTime(m.createdAt)].filter(Boolean).join(" · ")}
        </span>
      </div>
      <span className="grid justify-items-end">
        <span className={cn("figure text-sm font-medium whitespace-nowrap", m.direction === "in" && "text-success-foreground")}>
          <span className="sr-only">{m.direction === "in" ? "In " : "Out "}</span>
          <span aria-hidden>{m.direction === "in" ? "+" : "−"}</span>
          {formatNaira(m.amountKobo)}
        </span>
        <span className="text-xs text-muted-foreground figure">{formatNaira(m.balanceAfterKobo)}</span>
      </span>
    </li>
  )
}
