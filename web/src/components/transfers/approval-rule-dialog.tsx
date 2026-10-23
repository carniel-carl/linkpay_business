"use client"

import { useState } from "react"
import Link from "next/link"
import { ArrowRight, ShieldCheck } from "lucide-react"
import { toast } from "sonner"
import { updateApprovalRule } from "@/app/(dashboard)/transfers/actions"
import { FormError } from "@/components/common/form-error"
import { NairaInput } from "@/components/common/naira-input"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Field, FieldContent, FieldDescription, FieldError, FieldLabel, FieldSet, FieldTitle } from "@/components/ui/field"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Spinner } from "@/components/ui/spinner"
import { useTransactionPin } from "@/components/transaction-pin/use-transaction-pin"
import type { ApprovalMode, TransferSettings } from "@/lib/api/types"
import { koboToInput, parseNairaToKobo } from "@/lib/transfers"

const OPTIONS: { mode: ApprovalMode; title: string; description: string }[] = [
  { mode: "never", title: "Only for team members who can't approve", description: "Owners, admins and approvers send straight away." },
  { mode: "above_threshold", title: "From an amount you choose", description: "Transfers at or above it need a second person, whoever sends them." },
  { mode: "always", title: "Every transfer", description: "A second person approves every transfer before it leaves." },
  {
    mode: "workflow",
    title: "Approval levels by amount",
    description: "Name who approves, in up to 3 levels, with bigger amounts going through more people.",
  },
]

export function ApprovalRuleDialog({ settings }: { settings: TransferSettings }) {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<ApprovalMode>(settings.approval.mode)
  const [threshold, setThreshold] = useState(settings.approval.thresholdKobo !== null ? koboToInput(settings.approval.thresholdKobo) : "")
  const [thresholdError, setThresholdError] = useState<string>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const pin = useTransactionPin()

  async function save() {
    setError(undefined)
    setThresholdError(undefined)
    let input: Parameters<typeof updateApprovalRule>[0]
    // Workflows are saved from their own editor.
    if (mode === "workflow") return
    if (mode === "above_threshold") {
      const kobo = parseNairaToKobo(threshold)
      if (kobo === null || kobo < 100) return setThresholdError("Enter an amount of at least ₦1.")
      input = { mode, thresholdKobo: kobo }
    } else input = { mode }
    setBusy(true)
    const result = await pin.confirm({
      purpose: "change when transfers need approval",
      confirmLabel: "Save rule",
      run: (transactionPin) => updateApprovalRule(input, transactionPin),
    })
    setBusy(false)
    if (!result) return
    if (!result.ok) return setError(result.error)
    toast.success("Approval rule saved.")
    setOpen(false)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          setMode(settings.approval.mode)
          setThreshold(settings.approval.thresholdKobo !== null ? koboToInput(settings.approval.thresholdKobo) : "")
          setError(undefined)
          setThresholdError(undefined)
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline">
          <ShieldCheck data-icon="inline-start" aria-hidden />
          Approval rule
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>When do transfers need approval?</DialogTitle>
          <DialogDescription>
            A second person with approval access checks the transfer before money leaves. Nobody can approve their own transfer.
          </DialogDescription>
        </DialogHeader>
        <FormError message={error} />
        <FieldSet>
          <RadioGroup value={mode} onValueChange={(v) => setMode(v as ApprovalMode)} aria-label="Approval rule">
            {OPTIONS.map((o) => (
              <FieldLabel key={o.mode} htmlFor={`approval-${o.mode}`}>
                <Field orientation="horizontal">
                  <FieldContent>
                    <FieldTitle>{o.title}</FieldTitle>
                    <FieldDescription className="text-xs">{o.description}</FieldDescription>
                  </FieldContent>
                  <RadioGroupItem value={o.mode} id={`approval-${o.mode}`} />
                </Field>
              </FieldLabel>
            ))}
          </RadioGroup>
        </FieldSet>
        {mode === "above_threshold" && (
          <Field data-invalid={!!thresholdError}>
            <FieldLabel htmlFor="approval-threshold">Needs approval from</FieldLabel>
            <NairaInput id="approval-threshold" placeholder="500,000" value={threshold} invalid={!!thresholdError} onChange={setThreshold} />
            {thresholdError && <FieldError>{thresholdError}</FieldError>}
          </Field>
        )}
        {mode === "workflow" && (
          <p className="rounded-lg bg-muted px-3 py-2.5 text-sm text-muted-foreground">
            {settings.approval.mode === "workflow"
              ? `Your levels are set up for ${settings.approval.tiers.length === 1 ? "one amount band" : `${settings.approval.tiers.length} amount bands`}. Change them on the next page.`
              : "Choose the amounts and the people on the next page. The current rule stays until you save there."}
          </p>
        )}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={busy}>
              Cancel
            </Button>
          </DialogClose>
          {mode === "workflow" ? (
            <Button asChild>
              <Link href="/approvals/setup" onClick={() => setOpen(false)}>
                {settings.approval.mode === "workflow" ? "Edit levels" : "Set up levels"}
                <ArrowRight data-icon="inline-end" aria-hidden />
              </Link>
            </Button>
          ) : (
            <Button onClick={save} disabled={busy}>
              {busy && <Spinner />}
              Save rule
            </Button>
          )}
        </DialogFooter>
        {pin.dialog}
      </DialogContent>
    </Dialog>
  )
}
