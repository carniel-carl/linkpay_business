"use client"

import { useState } from "react"
import { Check } from "lucide-react"
import { toast } from "sonner"
import { createPocket, updatePocket } from "@/app/(dashboard)/savings/actions"
import { FormError } from "@/components/common/form-error"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
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
import { Field, FieldDescription, FieldError, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group"
import { NativeSelect } from "@/components/ui/native-select"
import { Spinner } from "@/components/ui/spinner"
import type { Pocket, PocketColor, PocketIcon } from "@/lib/api/types"
import { formatNaira } from "@/lib/format"
import {
  COLOR_LABELS,
  parsePercentToBps,
  POCKET_COLORS,
  POCKET_ICON_KEYS,
  POCKET_ICONS,
  pocketColorStyle,
  todayInLagos,
} from "@/lib/savings"
import { koboToInput, parseNairaToKobo } from "@/lib/transfers"
import { cn } from "@/lib/utils"
import { PocketTile } from "./parts"

/** A branch a pocket can be opened on: its account is ready. */
export type PocketBranch = { _id: string; name: string; availableKobo: number | null }

type AutoMode = "off" | "percent" | "amount"

type Values = {
  name: string
  icon: PocketIcon
  color: PocketColor
  branch: string
  hasTarget: boolean
  targetAmount: string
  targetDate: string
  auto: AutoMode
  percent: string
  autoAmount: string
}

function defaults(pocket: Pocket | undefined, branchId: string): Values {
  const auto = pocket?.autoSave
  return {
    name: pocket?.name ?? "",
    icon: pocket?.icon ?? "savings",
    color: pocket?.color ?? "lime",
    branch: pocket?.branch?._id ?? branchId,
    hasTarget: !!pocket?.target,
    targetAmount: pocket?.target ? koboToInput(pocket.target.amountKobo).replace(/\.00$/, "") : "",
    targetDate: pocket?.target?.date ?? "",
    auto: !auto ? "off" : auto.percentBps !== null ? "percent" : "amount",
    percent: auto?.percentBps != null ? String(auto.percentBps / 100) : "",
    autoAmount: auto?.amountKobo != null ? koboToInput(auto.amountKobo).replace(/\.00$/, "") : "",
  }
}

const MAX_KOBO = 10_000_000_000

/** Create a pocket, or edit one when `pocket` is given. The trigger is passed as children. */
export function PocketFormDialog({
  pocket,
  branches,
  defaultBranchId,
  children,
}: {
  pocket?: Pocket
  /** Branches with a ready account (create only). */
  branches: PocketBranch[]
  defaultBranchId?: string
  children: React.ReactNode
}) {
  const editing = !!pocket
  const startBranch = branches.find((b) => b._id === defaultBranchId)?._id ?? branches[0]?._id ?? ""
  const [open, setOpen] = useState(false)
  const [v, setV] = useState<Values>(() => defaults(pocket, startBranch))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  const set = <K extends keyof Values>(key: K, value: Values[K]) => setV((prev) => ({ ...prev, [key]: value }))
  const branchName = editing ? pocket.branch?.name : branches.find((b) => b._id === v.branch)?.name
  const tomorrow = nextDay(todayInLagos())

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const next: Record<string, string> = {}
    const name = v.name.trim()
    if (!name) next.name = "Give the pocket a name."
    if (!editing && !v.branch) next.branch = "Choose a branch."

    let target: { amountKobo: number; date: string | null } | null = null
    if (v.hasTarget) {
      const kobo = parseNairaToKobo(v.targetAmount)
      if (kobo === null || kobo < 100 || kobo > MAX_KOBO) next.targetAmount = "Enter a target between ₦1 and ₦100,000,000."
      // An unchanged date may have passed already; a new one must be in the future.
      const keptDate = editing && v.targetDate === pocket.target?.date
      if (v.targetDate && !keptDate && v.targetDate < tomorrow) next["target.date"] = "Choose a date after today."
      if (kobo !== null) target = { amountKobo: kobo, date: v.targetDate || null }
    }

    let autoSave: { percentBps: number } | { amountKobo: number } | null = null
    if (v.auto === "percent") {
      const bps = parsePercentToBps(v.percent)
      if (bps === null || bps < 100 || bps > 10_000) next.percent = "Enter a percentage from 1 to 100."
      else autoSave = { percentBps: bps }
    } else if (v.auto === "amount") {
      const kobo = parseNairaToKobo(v.autoAmount)
      if (kobo === null || kobo < 100 || kobo > MAX_KOBO) next.autoAmount = "Enter an amount of at least ₦1."
      else autoSave = { amountKobo: kobo }
    }

    setErrors(next)
    if (Object.keys(next).length) return

    setBusy(true)
    setError(undefined)
    const body = { name, icon: v.icon, color: v.color, target, autoSave }
    const result = editing
      ? await updatePocket(pocket._id, body)
      : await createPocket({
          branch: v.branch,
          name,
          icon: v.icon,
          color: v.color,
          ...(target && { target }),
          ...(autoSave && { autoSave }),
        })
    setBusy(false)
    if (!result.ok) {
      if (result.fieldErrors) setErrors(result.fieldErrors)
      if (!result.fieldErrors?.name && !result.fieldErrors?.["target.date"]) setError(result.error)
      return
    }
    toast.success(editing ? "Pocket updated." : `${result.data.name} is ready. Add money to it whenever you like.`)
    setOpen(false)
    if (!editing) setV(defaults(undefined, startBranch))
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        // Reopening starts from the saved values, not a half-edited draft.
        if (next) {
          setV(defaults(pocket, startBranch))
          setErrors({})
          setError(undefined)
        }
      }}
    >
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit ${pocket.name}` : "New pocket"}</DialogTitle>
          <DialogDescription>
            {editing
              ? "Changes apply straight away. The money in the pocket stays where it is."
              : "Money in a pocket stays in the branch's account but can't be spent by transfers until you move it back."}
          </DialogDescription>
        </DialogHeader>

        <FormError message={error} />

        <form id="pocket-form" onSubmit={submit} noValidate className="grid gap-6">
          <div className="flex items-end gap-4">
            <PocketTile icon={v.icon} color={v.color} className="size-14 rounded-[17px]" />
            <Field data-invalid={!!errors.name} className="flex-1">
              <FieldLabel htmlFor="pocket-name">Name</FieldLabel>
              <Input
                id="pocket-name"
                autoComplete="off"
                maxLength={40}
                placeholder="VAT and tax"
                value={v.name}
                aria-invalid={!!errors.name}
                onChange={(e) => set("name", e.target.value)}
              />
            </Field>
          </div>
          {errors.name && <FieldError className="-mt-4">{errors.name}</FieldError>}

          <FieldSet>
            <FieldLegend variant="label">Icon</FieldLegend>
            <div role="radiogroup" aria-label="Icon" style={pocketColorStyle(v.color)} className="grid grid-cols-5 gap-1.5 sm:grid-cols-10">
              {POCKET_ICON_KEYS.map((key) => {
                const { label, Icon } = POCKET_ICONS[key]
                return (
                  <ChoiceButton key={key} checked={v.icon === key} onClick={() => set("icon", key)} label={label}>
                    <Icon className="size-[18px]" strokeWidth={1.75} aria-hidden />
                  </ChoiceButton>
                )
              })}
            </div>
          </FieldSet>

          <FieldSet>
            <FieldLegend variant="label">Colour</FieldLegend>
            <div role="radiogroup" aria-label="Colour" className="flex flex-wrap gap-2">
              {POCKET_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  role="radio"
                  aria-checked={v.color === color}
                  aria-label={COLOR_LABELS[color]}
                  onClick={() => set("color", color)}
                  style={pocketColorStyle(color)}
                  className={cn(
                    "grid size-8 place-items-center rounded-full bg-(--pc) transition-transform duration-150 active:scale-95",
                    "focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                    v.color === color && "ring-2 ring-foreground ring-offset-2 ring-offset-background",
                  )}
                >
                  {v.color === color && <Check className="size-4 text-white mix-blend-difference" aria-hidden />}
                </button>
              ))}
            </div>
          </FieldSet>

          {editing ? (
            branchName && (
              <p className="rounded-lg bg-muted/70 px-3 py-2.5 text-sm text-muted-foreground">
                In <span className="font-medium text-foreground">{branchName}</span>. A pocket stays on the branch it was opened on.
              </p>
            )
          ) : (
            branches.length > 1 && (
              <Field data-invalid={!!errors.branch}>
                <FieldLabel htmlFor="pocket-branch">Branch</FieldLabel>
                <NativeSelect id="pocket-branch" value={v.branch} onChange={(e) => set("branch", e.target.value)}>
                  {branches.map((b) => (
                    <option key={b._id} value={b._id}>
                      {b.name}
                      {b.availableKobo !== null ? ` · ${formatNaira(b.availableKobo)} available` : ""}
                    </option>
                  ))}
                </NativeSelect>
                {errors.branch ? (
                  <FieldError>{errors.branch}</FieldError>
                ) : (
                  <FieldDescription>The money is set aside in this branch&apos;s account. This can&apos;t be changed later.</FieldDescription>
                )}
              </Field>
            )
          )}

          <FieldSet className="gap-4">
            <Field orientation="horizontal">
              <Checkbox id="pocket-has-target" checked={v.hasTarget} onCheckedChange={(c) => set("hasTarget", c === true)} />
              <FieldLabel htmlFor="pocket-has-target" className="font-normal">
                Save towards a target
              </FieldLabel>
            </Field>
            {v.hasTarget && (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field data-invalid={!!errors.targetAmount}>
                  <FieldLabel htmlFor="pocket-target">Target amount</FieldLabel>
                  <NairaInput id="pocket-target" value={v.targetAmount} invalid={!!errors.targetAmount} onChange={(x) => set("targetAmount", x)} />
                  {errors.targetAmount && <FieldError>{errors.targetAmount}</FieldError>}
                </Field>
                <Field data-invalid={!!errors["target.date"]}>
                  <FieldLabel htmlFor="pocket-date">By (optional)</FieldLabel>
                  <Input
                    id="pocket-date"
                    type="date"
                    min={tomorrow}
                    value={v.targetDate}
                    aria-invalid={!!errors["target.date"]}
                    onChange={(e) => set("targetDate", e.target.value)}
                  />
                  {errors["target.date"] && <FieldError>{errors["target.date"]}</FieldError>}
                </Field>
              </div>
            )}
          </FieldSet>

          <FieldSet className="gap-3">
            <FieldLegend variant="label">Auto-save</FieldLegend>
            <div role="radiogroup" aria-label="Auto-save" className="inline-flex h-9 w-fit items-center gap-0.5 rounded-full bg-muted p-0.5">
              {(
                [
                  ["off", "Off"],
                  ["percent", "A percentage"],
                  ["amount", "A fixed amount"],
                ] as const
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={v.auto === mode}
                  onClick={() => set("auto", mode)}
                  className={cn(
                    "h-8 rounded-full px-3.5 text-sm font-medium transition-colors duration-150 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                    v.auto === mode ? "bg-card text-foreground shadow-surface" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            {v.auto === "percent" && (
              <Field data-invalid={!!errors.percent} className="max-w-48">
                <FieldLabel htmlFor="pocket-percent" className="sr-only">
                  Percentage of each payment
                </FieldLabel>
                <InputGroup>
                  <InputGroupInput
                    id="pocket-percent"
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="5"
                    className="figure"
                    value={v.percent}
                    aria-invalid={!!errors.percent}
                    onChange={(e) => set("percent", e.target.value)}
                  />
                  <InputGroupAddon align="inline-end">
                    <InputGroupText>%</InputGroupText>
                  </InputGroupAddon>
                </InputGroup>
                {errors.percent && <FieldError>{errors.percent}</FieldError>}
              </Field>
            )}
            {v.auto === "amount" && (
              <Field data-invalid={!!errors.autoAmount} className="max-w-56">
                <FieldLabel htmlFor="pocket-auto-amount" className="sr-only">
                  Amount from each payment
                </FieldLabel>
                <NairaInput id="pocket-auto-amount" value={v.autoAmount} invalid={!!errors.autoAmount} onChange={(x) => set("autoAmount", x)} />
                {errors.autoAmount && <FieldError>{errors.autoAmount}</FieldError>}
              </Field>
            )}
            <FieldDescription>
              {v.auto === "off"
                ? "Save part of every payment into the branch automatically."
                : `From every payment into ${branchName ?? "the branch"} from now on${v.hasTarget ? ", until the target is reached" : ""}. Transfers between your own branches are skipped.`}
            </FieldDescription>
          </FieldSet>
        </form>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={busy}>
              Cancel
            </Button>
          </DialogClose>
          <Button type="submit" form="pocket-form" disabled={busy}>
            {busy && <Spinner />}
            {editing ? "Save changes" : "Create pocket"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ChoiceButton({
  checked,
  onClick,
  label,
  children,
}: {
  checked: boolean
  onClick: () => void
  label: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "grid aspect-square place-items-center rounded-[10px] text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground",
        "focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
        // Selected takes the pocket's colour, like the tile it previews.
        checked && "bg-(--pc-subtle) text-foreground ring-2 ring-foreground/70 hover:bg-(--pc-subtle)",
      )}
    >
      {children}
    </button>
  )
}

export function NairaInput({
  id,
  value,
  invalid,
  onChange,
  autoFocus,
}: {
  id: string
  value: string
  invalid?: boolean
  onChange: (value: string) => void
  autoFocus?: boolean
}) {
  return (
    <InputGroup>
      <InputGroupAddon>
        <InputGroupText>₦</InputGroupText>
      </InputGroupAddon>
      <InputGroupInput
        id={id}
        inputMode="decimal"
        autoComplete="off"
        placeholder="0.00"
        className="figure"
        value={value}
        autoFocus={autoFocus}
        aria-invalid={invalid}
        onChange={(e) => onChange(e.target.value)}
      />
    </InputGroup>
  )
}

/** "2026-10-21" -> "2026-10-22", in calendar days. */
function nextDay(day: string) {
  const [y, m, d] = day.split("-").map(Number)
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10)
}
