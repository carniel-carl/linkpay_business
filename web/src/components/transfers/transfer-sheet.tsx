"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { RotateCw } from "lucide-react"
import { toast } from "sonner"
import { actOnTransfer, approveTransfer } from "@/app/(dashboard)/transfers/actions"
import { CopyButton } from "@/components/accounts/copy-button"
import { FormError } from "@/components/common/form-error"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { useTransactionPin } from "@/components/transaction-pin/use-transaction-pin"
import type { Transfer } from "@/lib/api/types"
import { formatDateTime, formatNaira } from "@/lib/format"
import { KIND_LABELS } from "@/lib/transfers"
import { ApprovalTimeline } from "./approval-timeline"
import { KindIcon, recipientName, TransferAmount, TransferStatusBadge } from "./parts"

/** Everything about one transfer, with approve, reject and cancel where the member may. */
export function TransferSheet({ transfer, onClose }: { transfer: Transfer | null; onClose: () => void }) {
  return (
    <Sheet open={!!transfer} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="gap-0 overflow-y-auto p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-md">
        {transfer && <Details key={transfer._id} transfer={transfer} onDone={onClose} />}
      </SheetContent>
    </Sheet>
  )
}

function Details({ transfer: t, onDone }: { transfer: Transfer; onDone: () => void }) {
  const router = useRouter()
  const [note, setNote] = useState("")
  const [error, setError] = useState<string>()
  const [pending, setPending] = useState<"approve" | "reject" | "cancel" | null>(null)
  const [checking, startCheck] = useTransition()
  const pin = useTransactionPin()
  const levels = t.approval?.levels.length ?? 0
  const current = t.approval?.current ?? null
  // Approving an earlier level hands it on; only the last level sends the money.
  const finalLevel = current === null || current >= levels

  async function act(action: "approve" | "reject" | "cancel") {
    setPending(action)
    setError(undefined)
    // Approving takes the transaction PIN; rejecting and cancelling don't.
    const result =
      action === "approve"
        ? await pin.confirm({
            purpose: finalLevel
              ? `approve ${formatNaira(t.amountKobo)} to ${recipientName(t)} and send it`
              : `approve level ${current} of ${formatNaira(t.amountKobo)} to ${recipientName(t)}`,
            confirmLabel: finalLevel ? "Approve and send" : `Approve level ${current}`,
            run: (transactionPin) => approveTransfer(t._id, note, transactionPin),
          })
        : await actOnTransfer(t._id, action, note)
    setPending(null)
    if (!result) return
    if (!result.ok) return setError(result.error)
    toast.success(
      action === "approve"
        ? finalLevel
          ? `Approved. ${formatNaira(t.amountKobo)} is on its way to ${recipientName(t)}.`
          : `Level ${current} approved. It now goes to level ${current! + 1} of ${levels}.`
        : action === "reject"
          ? "Rejected. The money is available again."
          : "Transfer cancelled. The money is available again.",
    )
    onDone()
  }

  function check() {
    startCheck(async () => {
      const result = await actOnTransfer(t._id, "refresh")
      if (!result.ok) toast.error(result.error)
      else router.refresh()
    })
  }

  return (
    <>
      <SheetHeader className="gap-5 border-b bg-muted/50 p-6 pr-14">
        <div className="flex items-center gap-3">
          <KindIcon transfer={t} />
          <TransferStatusBadge status={t.status} />
        </div>
        <div className="grid gap-1.5">
          <SheetTitle className="type-display text-4xl font-normal">
            <TransferAmount kobo={t.amountKobo} className="font-[inherit]" />
          </SheetTitle>
          <SheetDescription>
            To <span className="font-medium text-foreground">{recipientName(t)}</span>, {formatDateTime(t.createdAt)}
          </SheetDescription>
        </div>
        {t.status === "failed" && t.failureReason && (
          <p className="rounded-lg bg-destructive/10 px-3 py-2.5 text-sm text-destructive">{t.failureReason}. Any money taken has been returned.</p>
        )}
        {t.status === "rejected" && (
          <p className="rounded-lg bg-muted px-3 py-2.5 text-sm text-muted-foreground">
            {t.decision?.by?.name ?? "An approver"} rejected this{t.decision?.note ? `: “${t.decision.note}”` : "."} Nothing was sent.
          </p>
        )}
      </SheetHeader>

      <div className="grid gap-7 p-6">
        <Group title="Amount">
          <Row label="Amount sent" value={<span className="figure">{formatNaira(t.amountKobo)}</span>} />
          <Row
            label="Fee"
            value={
              <span className="grid justify-items-end">
                <span className="figure">{formatNaira(t.feeKobo)}</span>
                {t.stampDutyKobo > 0 && (
                  <span className="text-xs text-muted-foreground">
                    includes <span className="figure">{formatNaira(t.stampDutyKobo)}</span> stamp duty
                  </span>
                )}
              </span>
            }
          />
          <Row label="Total from the account" value={<span className="figure font-semibold">{formatNaira(t.totalKobo)}</span>} />
        </Group>

        {t.approval && (
          <section className="grid gap-2">
            <h3 className="text-xs font-medium text-muted-foreground">
              {levels > 1 ? `Approvals, ${levels} levels` : "Approval"}
            </h3>
            <ApprovalTimeline approval={t.approval} decision={t.decision} />
          </section>
        )}

        <Group title="Recipient">
          <Row label="Name" value={t.recipient.accountName} />
          {t.recipient.branch && <Row label="Branch" value={t.recipient.branch.name} />}
          <Row label="Bank" value={t.recipient.bankName} />
          <Row label="Account number" value={<span className="font-mono tracking-[0.04em]">{t.recipient.accountNumber}</span>} />
        </Group>

        <Group title="Details">
          <Row label="Type" value={KIND_LABELS[t.kind]} />
          <Row label="From" value={t.branch?.name} />
          <Row label="Narration" value={t.narration} />
          <Row
            label="Reference"
            value={
              <span className="flex min-w-0 items-center justify-end gap-0.5">
                <span className="truncate font-mono text-xs">{t.reference}</span>
                <CopyButton value={t.reference} message="Reference copied" label="Copy reference" />
              </span>
            }
          />
          <Row label="Prepared by" value={t.createdBy?.name} />
          {t.decision && !t.approval && (
            <Row
              label={t.status === "rejected" ? "Rejected by" : "Approved by"}
              value={`${t.decision.by?.name ?? "Unknown"}, ${formatDateTime(t.decision.at)}`}
            />
          )}
          {t.completedAt && <Row label="Finished" value={formatDateTime(t.completedAt)} />}
        </Group>
      </div>

      {(t.canApprove || t.canCancel || t.status === "processing") && (
        <SheetFooter className="sticky bottom-0 gap-3 border-t bg-card p-6">
          <FormError message={error} />
          {t.canApprove && (
            <>
              <Field>
                <FieldLabel htmlFor="decision-note">Note (optional)</FieldLabel>
                <Textarea id="decision-note" rows={2} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
                <FieldDescription>
                  {finalLevel ? "The person who prepared it sees this." : "The next approvers and the person who prepared it see this."}
                </FieldDescription>
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Button write="block" className="w-full" variant="outline" disabled={!!pending} onClick={() => act("reject")}>
                  {pending === "reject" && <Spinner />}
                  Reject
                </Button>
                <Button write="block" className="w-full" disabled={!!pending} onClick={() => act("approve")}>
                  {pending === "approve" && <Spinner />}
                  {finalLevel ? "Approve and send" : `Approve level ${current}`}
                </Button>
              </div>
            </>
          )}
          {t.canCancel && (
            <Button write="block" variant="outline" disabled={!!pending} onClick={() => act("cancel")}>
              {pending === "cancel" && <Spinner />}
              Cancel transfer
            </Button>
          )}
          {t.status === "processing" && (
            // Only asks the bank how the payout is doing, so the API allows it while the business is suspended.
            <Button variant="outline" disabled={checking} onClick={check}>
              {checking ? <Spinner /> : <RotateCw data-icon="inline-start" aria-hidden />}
              Check status now
            </Button>
          )}
        </SheetFooter>
      )}
      {pin.dialog}
    </>
  )
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-2">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      <dl className="divide-y rounded-xl border">{children}</dl>
    </section>
  )
}

function Row({ label, value }: { label: string; value?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-6 px-4 py-3 text-sm">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right break-words">{value || <span className="text-muted-foreground">Not given</span>}</dd>
    </div>
  )
}
