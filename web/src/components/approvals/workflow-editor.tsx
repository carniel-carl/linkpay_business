"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Check, Plus, Trash2, TriangleAlert, UserPlus, X } from "lucide-react"
import { toast } from "sonner"
import { updateApprovalRule } from "@/app/(dashboard)/transfers/actions"
import { FormError } from "@/components/common/form-error"
import { NairaInput } from "@/components/common/naira-input"
import { Button } from "@/components/ui/button"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Spinner } from "@/components/ui/spinner"
import { useTransactionPin } from "@/components/transaction-pin/use-transaction-pin"
import type { Approver, TransferSettings } from "@/lib/api/types"
import { formatNaira } from "@/lib/format"
import { koboToInput, parseNairaToKobo } from "@/lib/transfers"
import { cn } from "@/lib/utils"
import { tierRange } from "./workflow-summary"

// The backend's limits.
const MAX_TIERS = 5
const MAX_LEVELS = 3
const MAX_APPROVERS = 10

/** Someone named at a level. `gone` people are still in the saved rule but can no longer approve. */
type Person = { _id: string; name: string; detail: string; gone?: boolean }
type Level = { key: string; approvers: string[] }
type Tier = { key: string; amount: string; levels: Level[] }

let seq = 0
const key = () => `k${++seq}`
const blankLevel = (): Level => ({ key: key(), approvers: [] })

/** "Owner", or "Approver · only Ikeja, Kano" when their access is limited to some branches. */
const describe = (a: Approver) =>
  a.branches ? `${a.roleLabel} · only ${a.branches.map((b) => b.name).join(", ") || "no branches"}` : a.roleLabel

export function WorkflowEditor({ settings, approvers }: { settings: TransferSettings; approvers: Approver[] }) {
  const router = useRouter()

  // Everyone the rule can name, plus anyone already named who has since lost the right to approve.
  const people = new Map<string, Person>(approvers.map((a) => [a._id, { _id: a._id, name: a.name, detail: describe(a) }]))
  for (const tier of settings.approval.tiers)
    for (const level of tier.levels)
      for (const a of level.approvers)
        if (!people.has(a._id)) people.set(a._id, { _id: a._id, name: a.name, detail: "Can no longer approve", gone: true })

  const [tiers, setTiers] = useState<Tier[]>(() =>
    settings.approval.mode === "workflow" && settings.approval.tiers.length
      ? settings.approval.tiers.map((t) => ({
          key: key(),
          amount: koboToInput(t.minKobo),
          levels: t.levels.map((l) => ({ key: key(), approvers: l.approvers.map((a) => a._id) })),
        }))
      : [{ key: key(), amount: "", levels: [blankLevel()] }],
  )
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const pin = useTransactionPin()

  const updateTier = (tierKey: string, change: (t: Tier) => Tier) => setTiers((all) => all.map((t) => (t.key === tierKey ? change(t) : t)))
  const updateLevel = (tierKey: string, levelKey: string, change: (l: Level) => Level) =>
    updateTier(tierKey, (t) => ({ ...t, levels: t.levels.map((l) => (l.key === levelKey ? change(l) : l)) }))

  // Bands in amount order, for the "₦X to ₦Y" labels (unreadable amounts sort last).
  const amounts = tiers.map((t) => parseNairaToKobo(t.amount))
  const ordered = tiers
    .map((t, i) => ({ key: t.key, minKobo: amounts[i] }))
    .filter((t): t is { key: string; minKobo: number } => t.minKobo !== null)
    .sort((a, b) => a.minKobo - b.minKobo)
  const rangeOf = (tierKey: string) => {
    const i = ordered.findIndex((t) => t.key === tierKey)
    return i === -1 ? null : tierRange(ordered, i)
  }

  function validate() {
    const found: Record<string, string> = {}
    const seen = new Map<number, string>()
    tiers.forEach((t, i) => {
      const kobo = amounts[i]
      if (kobo === null) found[t.key] = "Enter an amount. Use 0 to cover every transfer."
      else if (seen.has(kobo)) found[t.key] = "Another band starts at this amount."
      else seen.set(kobo, t.key)
      for (const l of t.levels) {
        const gone = l.approvers.filter((id) => people.get(id)?.gone)
        if (!l.approvers.length) found[l.key] = "Add at least one approver."
        else if (gone.length) found[l.key] = `Remove ${gone.map((id) => people.get(id)!.name).join(", ")}, who can no longer approve.`
      }
    })
    return found
  }

  async function save() {
    setError(undefined)
    const found = validate()
    setErrors(found)
    if (Object.keys(found).length) return setError("Some bands need fixing before you save.")
    setBusy(true)
    const rule = {
      mode: "workflow" as const,
      tiers: tiers.map((t, i) => ({ minKobo: amounts[i]!, levels: t.levels.map((l) => ({ approvers: l.approvers })) })),
    }
    const result = await pin.confirm({
      purpose: "save these approval levels",
      confirmLabel: "Save approval levels",
      run: (transactionPin) => updateApprovalRule(rule, transactionPin),
    })
    setBusy(false)
    if (!result) return
    if (!result.ok) return setError(result.error)
    toast.success("Approval levels saved. New transfers follow them; ones already waiting keep their levels.")
    router.push("/approvals")
  }

  return (
    <div className="grid gap-6">
      {approvers.length < 2 && (
        <p className="surface flex items-start gap-3 p-5 text-sm sm:p-6">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning-foreground" aria-hidden />
          <span>
            Only {approvers.length === 1 ? `${approvers[0].name} can` : "nobody can"} approve transfers right now. Nobody approves their own transfer,
            so <Link href="/team" className="font-medium underline underline-offset-4">invite an approver or admin</Link> before setting up levels.
          </span>
        </p>
      )}

      <FormError message={error} />

      <ol className="grid gap-4">
        {tiers.map((tier, ti) => {
          const range = rangeOf(tier.key)
          return (
            <li key={tier.key} className="surface grid gap-5 p-5 sm:p-6" aria-label={`Amount band ${ti + 1}`}>
              <div className="flex flex-wrap items-end justify-between gap-4">
                <Field data-invalid={!!errors[tier.key]} className="w-full sm:w-72">
                  <FieldLabel htmlFor={`${tier.key}-amount`}>Transfers from</FieldLabel>
                  <NairaInput
                    id={`${tier.key}-amount`}
                    placeholder="100,000"
                    value={tier.amount}
                    invalid={!!errors[tier.key]}
                    onChange={(amount) => updateTier(tier.key, (t) => ({ ...t, amount }))}
                  />
                  {errors[tier.key] ? (
                    <FieldError>{errors[tier.key]}</FieldError>
                  ) : (
                    <FieldDescription className="figure">{range ?? "Up to the next band"}</FieldDescription>
                  )}
                </Field>
                {tiers.length > 1 && (
                  <Button variant="ghost" size="sm" onClick={() => setTiers((all) => all.filter((t) => t.key !== tier.key))}>
                    <Trash2 data-icon="inline-start" aria-hidden />
                    Remove band
                  </Button>
                )}
              </div>

              <ol className="grid gap-3">
                {tier.levels.map((level, li) => {
                  // Nobody can be at two levels of one band.
                  const elsewhere = new Map(
                    tier.levels.flatMap((l, j) => (l.key === level.key ? [] : l.approvers.map((id) => [id, j + 1] as const))),
                  )
                  const only = level.approvers.length === 1 ? people.get(level.approvers[0]) : undefined
                  return (
                    <li key={level.key} className="grid gap-3 rounded-xl border p-4" data-invalid={!!errors[level.key] || undefined}>
                      <div className="flex items-center justify-between gap-3">
                        <p className="flex items-center gap-2.5 text-sm font-medium">
                          <span className="grid size-6 place-items-center rounded-full bg-muted text-xs figure" aria-hidden>
                            {li + 1}
                          </span>
                          Level {li + 1}
                          <span className="font-normal text-muted-foreground">· any one of them approves</span>
                        </p>
                        {tier.levels.length > 1 && (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Remove level ${li + 1}`}
                            onClick={() => updateTier(tier.key, (t) => ({ ...t, levels: t.levels.filter((l) => l.key !== level.key) }))}
                          >
                            <X aria-hidden />
                          </Button>
                        )}
                      </div>

                      <ul className="flex flex-wrap gap-2" aria-label={`Approvers at level ${li + 1}`}>
                        {level.approvers.map((id) => {
                          const p = people.get(id)
                          return (
                            <li
                              key={id}
                              className={cn(
                                "flex items-center gap-1 rounded-full border py-1 pr-1 pl-3 text-sm",
                                p?.gone && "border-warning-foreground/40 bg-warning-subtle text-warning-foreground",
                              )}
                            >
                              {p?.name ?? "Unknown"}
                              {p?.gone && <span className="text-xs">(can no longer approve)</span>}
                              <Button
                                variant="ghost"
                                size="icon-xs"
                                className="rounded-full"
                                aria-label={`Remove ${p?.name ?? "approver"}`}
                                onClick={() => updateLevel(tier.key, level.key, (l) => ({ ...l, approvers: l.approvers.filter((x) => x !== id) }))}
                              >
                                <X aria-hidden />
                              </Button>
                            </li>
                          )
                        })}
                        {level.approvers.length < MAX_APPROVERS && (
                          <li>
                            <PeoplePicker
                              approvers={approvers}
                              selected={level.approvers}
                              elsewhere={elsewhere}
                              onToggle={(id) =>
                                updateLevel(tier.key, level.key, (l) => ({
                                  ...l,
                                  approvers: l.approvers.includes(id) ? l.approvers.filter((x) => x !== id) : [...l.approvers, id],
                                }))
                              }
                            />
                          </li>
                        )}
                      </ul>

                      {errors[level.key] ? (
                        <p className="text-sm text-destructive">{errors[level.key]}</p>
                      ) : (
                        only &&
                        !only.gone && (
                          <p className="text-xs text-muted-foreground">
                            If {only.name} sends a transfer in this band, nobody else can approve this level, so it will be refused. Add someone else to avoid that.
                          </p>
                        )
                      )}
                    </li>
                  )
                })}
              </ol>

              {tier.levels.length < MAX_LEVELS && (
                <Button
                  variant="outline"
                  size="sm"
                  className="w-fit"
                  onClick={() => updateTier(tier.key, (t) => ({ ...t, levels: [...t.levels, blankLevel()] }))}
                >
                  <Plus data-icon="inline-start" aria-hidden />
                  Add level {tier.levels.length + 1}
                </Button>
              )}
            </li>
          )
        })}
      </ol>

      <div className="flex flex-wrap items-center justify-between gap-3">
        {tiers.length < MAX_TIERS ? (
          <Button
            variant="outline"
            onClick={() => setTiers((all) => [...all, { key: key(), amount: "", levels: [blankLevel()] }])}
          >
            <Plus data-icon="inline-start" aria-hidden />
            Add amount band
          </Button>
        ) : (
          <p className="text-sm text-muted-foreground">You can have up to {MAX_TIERS} amount bands.</p>
        )}
        <div className="flex gap-2">
          <Button variant="outline" asChild disabled={busy}>
            <Link href="/approvals">Cancel</Link>
          </Button>
          <Button onClick={save} disabled={busy}>
            {busy && <Spinner />}
            Save approval levels
          </Button>
        </div>
      </div>

      <p className="text-sm text-muted-foreground">
        {ordered[0] && ordered[0].minKobo > 0
          ? `Transfers under ${formatNaira(ordered[0].minKobo)} go straight away, unless the person sending can't approve transfers; then anyone who can approve checks it. `
          : ""}
        Transfers already waiting keep the levels they started with. To go back to a simple rule, use Approval rule on the Transfers page.
      </p>
      {pin.dialog}
    </div>
  )
}

/** Adds or removes people at one level. People at another level of the band are shown but can't be picked. */
function PeoplePicker({
  approvers,
  selected,
  elsewhere,
  onToggle,
}: {
  approvers: Approver[]
  selected: string[]
  /** User id → the level they're already at in this band. */
  elsewhere: Map<string, number>
  onToggle: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="rounded-full">
          <UserPlus data-icon="inline-start" aria-hidden />
          {selected.length ? "Add or remove" : "Add approvers"}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        <Command>
          <CommandInput placeholder="Search people" />
          <CommandList>
            <CommandEmpty>Nobody by that name can approve transfers.</CommandEmpty>
            <CommandGroup>
              {approvers.map((a) => {
                const at = elsewhere.get(a._id)
                const picked = selected.includes(a._id)
                return (
                  <CommandItem
                    key={a._id}
                    value={`${a.name} ${a.email}`}
                    disabled={at !== undefined}
                    onSelect={() => onToggle(a._id)}
                    className="items-start"
                  >
                    <span className={cn("mt-0.5 grid size-4 shrink-0 place-items-center rounded-sm border", picked && "border-primary bg-primary text-primary-foreground")}>
                      {picked && <Check className="size-3" aria-hidden />}
                    </span>
                    <span className="grid min-w-0 gap-0.5">
                      <span className="truncate">{a.name}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {at !== undefined ? `Already at level ${at}` : describe(a)}
                      </span>
                    </span>
                  </CommandItem>
                )
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
