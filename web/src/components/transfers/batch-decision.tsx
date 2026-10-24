"use client"

import { useId, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { approveBatch, rejectBatch } from "@/app/(dashboard)/transfers/actions"
import { useTransactionPin } from "@/components/transaction-pin/use-transaction-pin"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import type { Transfer, TransferBatchDecision, TransferBatchLevel } from "@/lib/api/types"

const transfers = (n: number) => (n === 1 ? "1 transfer" : `${n} transfers`)

/** "Approved 2 transfers. 1 is waiting for someone else." */
function decidedMessage(action: "approve" | "reject", { decided, skipped }: TransferBatchDecision) {
  const done = action === "approve" ? `Approved ${transfers(decided)}.` : `Rejected ${transfers(decided)}. The money is available again.`
  if (!skipped) return done
  return `${done} ${skipped} ${skipped === 1 ? "is" : "are"} waiting for someone else.`
}

/**
 * "Approve N waiting for you" (with the PIN) and "Reject N" (confirmed, with an optional note) for a bulk transfer.
 * Both decide only the `awaitingMe` rows; rows at other levels or for other approvers stay waiting for them, so a
 * batch with rows at mixed levels can still be decided here. Renders nothing when nothing waits for the member.
 */
export function BatchDecisionButtons({ batchId, awaitingMe, size = "default" }: { batchId: string; awaitingMe: number; size?: "default" | "sm" }) {
  const router = useRouter()
  const pin = useTransactionPin()
  const noteId = useId()
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null)
  const [rejecting, setRejecting] = useState(false)
  const [note, setNote] = useState("")

  async function decide(action: "approve" | "reject") {
    setBusy(action)
    const result =
      action === "approve"
        ? await pin.confirm({
            purpose: `approve ${awaitingMe === 1 ? "the transfer" : `the ${awaitingMe} transfers`} waiting for you in this bulk transfer`,
            confirmLabel: `Approve ${awaitingMe}`,
            run: (transactionPin) => approveBatch(batchId, transactionPin),
          })
        : await rejectBatch(batchId, note)
    setBusy(null)
    if (!result) return
    setRejecting(false)
    if (!result.ok) {
      // The batch changed since the page loaded: show where it is now.
      if (result.code === "NOTHING_TO_DECIDE" || result.code === "TRANSFER_NOT_PENDING") router.refresh()
      return toast.error(result.error)
    }
    setNote("")
    toast.success(decidedMessage(action, result.data))
  }

  if (awaitingMe <= 0) return null

  return (
    <>
      <Button size={size} disabled={!!busy} onClick={() => decide("approve")}>
        {busy === "approve" && <Spinner />}
        Approve {awaitingMe} waiting for you
      </Button>
      <Button size={size} variant="outline" disabled={!!busy} onClick={() => setRejecting(true)}>
        Reject {awaitingMe}
      </Button>

      <AlertDialog open={rejecting} onOpenChange={(o) => !o && !busy && setRejecting(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reject {transfers(awaitingMe)}?</AlertDialogTitle>
            <AlertDialogDescription>
              {awaitingMe === 1 ? "The transfer" : `The ${awaitingMe} transfers`} waiting for you in this bulk transfer won&apos;t be sent.
              Anything waiting for someone else stays as it is.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Field>
            <FieldLabel htmlFor={noteId}>Note (optional)</FieldLabel>
            <Textarea id={noteId} rows={2} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
            <FieldDescription>The person who prepared it sees this.</FieldDescription>
          </Field>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={!!busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={!!busy}
              onClick={(e) => {
                e.preventDefault()
                void decide("reject")
              }}
            >
              {busy === "reject" && <Spinner />}
              Reject {awaitingMe}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {pin.dialog}
    </>
  )
}

/** A bulk transfer's waiting rows by level, worked out from its rows (GET /batches/:id has no `levels`). */
export function waitingLevels(items: Transfer[]): TransferBatchLevel[] {
  const groups = new Map<string, TransferBatchLevel>()
  for (const t of items) {
    if (t.status !== "pending_approval") continue
    const level = t.approval?.current ?? 1
    const of = Math.max(t.approval?.levels.length ?? 0, 1)
    const group = groups.get(`${level}/${of}`) ?? { level, of, waiting: 0, awaitingMe: 0 }
    group.waiting += 1
    if (t.canApprove) group.awaitingMe += 1
    groups.set(`${level}/${of}`, group)
  }
  return [...groups.values()].sort((a, b) => a.level - b.level || a.of - b.of)
}

/** "Level 1 of 2 · 3 waiting for you", or just "3 waiting for you" when there's one level. */
export function levelText({ level, of, waiting, awaitingMe }: TransferBatchLevel) {
  const who =
    awaitingMe === waiting ? `${waiting} waiting for you` : awaitingMe === 0 ? `${waiting} waiting for someone else` : `${awaitingMe} of ${waiting} waiting for you`
  return of > 1 ? `Level ${level} of ${of} · ${who}` : who
}
