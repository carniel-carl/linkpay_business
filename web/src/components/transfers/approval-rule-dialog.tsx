"use client"

import { useState } from "react"
import { ShieldCheck } from "lucide-react"
import { toast } from "sonner"
import { updateApprovalRule } from "@/app/(dashboard)/transfers/actions"
import { FormError } from "@/components/common/form-error"
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
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Spinner } from "@/components/ui/spinner"
import type { ApprovalMode, TransferSettings } from "@/lib/api/types"
import { koboToInput, parseNairaToKobo } from "@/lib/transfers"

const OPTIONS: { mode: ApprovalMode; title: string; description: string }[] = [
  { mode: "never", title: "Only for team members who can't approve", description: "Owners, admins and approvers send straight away." },
  { mode: "above_threshold", title: "From an amount you choose", description: "Transfers at or above it need a second person, whoever sends them." },
  { mode: "always", title: "Every transfer", description: "A second person approves every transfer before it leaves." },
]

export function ApprovalRuleDialog({ settings }: { settings: TransferSettings }) {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<ApprovalMode>(settings.approval.mode)
  const [threshold, setThreshold] = useState(settings.approval.thresholdKobo !== null ? koboToInput(settings.approval.thresholdKobo) : "")
  const [thresholdError, setThresholdError] = useState<string>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  async function save() {
    setError(undefined)
    setThresholdError(undefined)
    let input: Parameters<typeof updateApprovalRule>[0]
    if (mode === "above_threshold") {
      const kobo = parseNairaToKobo(threshold)
      if (kobo === null || kobo < 100) return setThresholdError("Enter an amount of at least ₦1.")
      input = { mode, thresholdKobo: kobo }
    } else input = { mode }
    setBusy(true)
    const result = await updateApprovalRule(input)
    setBusy(false)
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
            <InputGroup>
              <InputGroupAddon>
                <InputGroupText>₦</InputGroupText>
              </InputGroupAddon>
              <InputGroupInput
                id="approval-threshold"
                inputMode="decimal"
                placeholder="500,000"
                className="figure"
                value={threshold}
                aria-invalid={!!thresholdError}
                onChange={(e) => setThreshold(e.target.value)}
              />
            </InputGroup>
            {thresholdError && <FieldError>{thresholdError}</FieldError>}
          </Field>
        )}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={busy}>
              Cancel
            </Button>
          </DialogClose>
          <Button onClick={save} disabled={busy}>
            {busy && <Spinner />}
            Save rule
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
