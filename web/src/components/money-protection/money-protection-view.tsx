"use client"

import { useState } from "react"
import { Landmark, MoreHorizontal, Plus, ShieldAlert, Snowflake } from "lucide-react"
import { toast } from "sonner"
import {
  cancelSettlementAccount,
  cancelSettlementOnlyOff,
  enableSettlementOnly,
  freezeMoneyOut,
  removeSettlementAccount,
  requestSettlementOnlyOff,
  unfreezeMoneyOut,
} from "@/app/(dashboard)/settings/money-protection/actions"
import { useStepUp } from "@/components/security/step-up-dialog"
import type { SourceAccount } from "@/components/transfers/new-transfer-dialog"
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
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Field, FieldLabel } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import type { ActionResult } from "@/lib/action-result"
import type { SecurityEvent, SecurityState, SettlementAccount } from "@/lib/api/types"
import { formatDateTime, timeAgo } from "@/lib/format"
import { AddSettlementDialog } from "./add-settlement-dialog"
import { WithdrawDialog } from "./withdraw-dialog"

type Props = {
  security: SecurityState
  accounts: SettlementAccount[]
  events: SecurityEvent[] | null
  /** Branch accounts the member can withdraw from (empty without `transfers.create`). */
  sources: SourceAccount[]
  canManage: boolean
  canFreeze: boolean
}

export function MoneyProtectionView({ security, accounts, events, sources, canManage, canFreeze }: Props) {
  const { moneyOut, me, rules } = security
  const open = accounts.filter((a) => a.status === "active" || a.status === "pending")
  const ended = accounts.filter((a) => a.status !== "active" && a.status !== "pending")
  const atLimit = open.length >= rules.maxSettlementAccounts
  // Frozen, or this member is on a hold: money can't move, so don't offer it.
  const blocked = !!moneyOut.frozen || !!me.blocker

  return (
    <div className="grid gap-10">
      <Status security={security} />

      <section className="grid gap-4">
        <SectionHeading
          title="Settlement accounts"
          description={`Your business's own accounts at other banks, where you withdraw money to. LinkPay checks each new one and it can't be used for ${rules.settlementCoolingOffHours} hours.`}
          action={
            canManage &&
            open.length > 0 &&
            !atLimit &&
            !blocked && (
              <AddSettlementDialog twoFactorOn={me.twoFactor.enabled} coolingOffHours={rules.settlementCoolingOffHours}>
                <Button size="sm" variant="outline">
                  <Plus data-icon="inline-start" aria-hidden />
                  Add account
                </Button>
              </AddSettlementDialog>
            )
          }
        />
        {open.length === 0 ? (
          <Empty className="surface border-0 p-8">
            <EmptyHeader>
              <EmptyMedia variant="icon" className="bg-pop-subtle text-foreground">
                <Landmark aria-hidden />
              </EmptyMedia>
              <EmptyTitle className="type-display text-2xl">No settlement account yet</EmptyTitle>
              <EmptyDescription>
                {canManage
                  ? "Add your business's account at another bank so you can withdraw to it."
                  : "The business owner can add one. Withdrawals go only to accounts LinkPay has checked."}
              </EmptyDescription>
            </EmptyHeader>
            {canManage && !blocked && (
              <EmptyContent>
                <AddSettlementDialog twoFactorOn={me.twoFactor.enabled} coolingOffHours={rules.settlementCoolingOffHours}>
                  <Button>
                    <Plus data-icon="inline-start" aria-hidden />
                    Add settlement account
                  </Button>
                </AddSettlementDialog>
              </EmptyContent>
            )}
          </Empty>
        ) : (
          <ul className="divide-y surface">
            {open.map((a) => (
              <AccountRow key={a._id} account={a} sources={blocked ? [] : sources} canManage={canManage} />
            ))}
          </ul>
        )}
        {ended.length > 0 && (
          <Collapsible className="grid gap-3">
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm" className="justify-self-start text-muted-foreground">
                Earlier accounts ({ended.length})
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <ul className="divide-y surface">
                {ended.map((a) => (
                  <AccountRow key={a._id} account={a} sources={[]} canManage={false} />
                ))}
              </ul>
            </CollapsibleContent>
          </Collapsible>
        )}
      </section>

      <SettlementOnly security={security} canManage={canManage} />

      <Freeze security={security} canFreeze={canFreeze} />

      {events && (
        <section className="grid gap-4">
          <SectionHeading title="Security activity" description="Settlement accounts, freezes, wrong codes and protection changes, newest first." />
          {events.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing yet.</p>
          ) : (
            <ul className="divide-y surface">
              {events.map((e) => (
                <li key={e._id} className="grid gap-0.5 px-4 py-3">
                  <p className="text-sm">{e.summary}</p>
                  <p className="text-xs text-muted-foreground">
                    <time dateTime={e.createdAt} title={formatDateTime(e.createdAt)}>
                      {timeAgo(e.createdAt)}
                    </time>
                    {e.ip ? `, from ${e.ip}` : ""}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  )
}

function SectionHeading({ title, description, action, badge }: { title: string; description: string; action?: React.ReactNode; badge?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="grid max-w-prose gap-1">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          {title}
          {badge}
        </h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      {action}
    </div>
  )
}

/** Frozen, or something stopping this member moving money. */
function Status({ security }: { security: SecurityState }) {
  const { frozen } = security.moneyOut
  const { blocker, personalBlocker } = security.me
  const stepUp = useStepUp()
  const [busy, setBusy] = useState(false)

  async function unfreeze() {
    setBusy(true)
    const result = await stepUp.confirm("money_out.unfreeze", {}, (proof) => unfreezeMoneyOut(proof))
    setBusy(false)
    if (!result) return
    if (!result.ok) return toast.error(result.error)
    toast.success("Unfrozen. Transfers and withdrawals can go out again.")
  }

  if (frozen) {
    return (
      <div className="flex flex-wrap items-start gap-3 rounded-xl bg-destructive-subtle p-4 text-sm text-destructive">
        <Snowflake className="mt-0.5 size-4 shrink-0" aria-hidden />
        <div className="grid min-w-0 flex-1 gap-1">
          <p className="font-medium">Money out is frozen</p>
          <p>
            {frozen.source === "member" ? `${frozen.byName ?? "A team member"} froze it` : "LinkPay froze it to protect your business"} on{" "}
            {formatDateTime(frozen.at)}
            {frozen.reason ? `: ${frozen.reason}` : "."} Nothing can be sent, approved or withdrawn. Money still comes in.
          </p>
          {!frozen.canUnfreeze && frozen.source !== "member" && <p>Contact support so we can check your account and unfreeze it.</p>}
          {personalBlocker && (
            <p>
              {personalBlocker.message}
              {personalBlocker.until ? ` Until ${formatDateTime(personalBlocker.until)}.` : ""}
            </p>
          )}
        </div>
        {frozen.canUnfreeze && (
          <Button size="sm" variant="outline" onClick={unfreeze} disabled={busy}>
            {busy && <Spinner />}
            Unfreeze
          </Button>
        )}
        {stepUp.dialog}
      </div>
    )
  }
  if (!blocker) return null
  return (
    <div className="flex gap-3 rounded-xl bg-warning-subtle p-4 text-sm text-warning-foreground">
      <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      <p>
        {blocker.message}
        {blocker.until ? ` You can again from ${formatDateTime(blocker.until)}.` : ""}
      </p>
    </div>
  )
}

const STATUS: Record<SettlementAccount["status"], { label: string; variant: "success" | "warning" | "destructive" | "muted" }> = {
  active: { label: "Active", variant: "success" },
  pending: { label: "Being checked", variant: "warning" },
  rejected: { label: "Not approved", variant: "destructive" },
  cancelled: { label: "Cancelled", variant: "muted" },
  removed: { label: "Removed", variant: "muted" },
}

function AccountRow({ account: a, sources, canManage }: { account: SettlementAccount; sources: SourceAccount[]; canManage: boolean }) {
  const stepUp = useStepUp()
  const [busy, setBusy] = useState(false)
  const status = STATUS[a.status]

  async function run(promise: () => Promise<ActionResult<unknown> | null>, done: string) {
    setBusy(true)
    const result = await promise()
    setBusy(false)
    if (!result) return
    if (!result.ok) return toast.error(result.error)
    toast.success(done)
  }

  const note =
    a.status === "pending"
      ? a.review?.status === "approved"
        ? `Approved by LinkPay. Ready from ${formatDateTime(a.review.availableAt)}.`
        : `LinkPay is checking it. Ready from ${formatDateTime(a.review?.availableAt)} at the earliest.`
      : a.status === "rejected"
        ? `Not approved${a.review?.note ? `: ${a.review.note}` : "."}`
        : a.status === "active"
          ? a.lastWithdrawalAt
            ? `Last withdrawal ${timeAgo(a.lastWithdrawalAt)}.`
            : `Ready since ${formatDateTime(a.activatedAt ?? undefined)}.`
          : `Added by ${a.addedBy?.name ?? "a team member"} on ${formatDateTime(a.createdAt)}.`

  return (
    <li className="flex flex-wrap items-start gap-4 p-4 sm:flex-nowrap">
      <div className="grid min-w-0 flex-1 gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{a.accountName}</span>
          <Badge variant={status.variant}>{status.label}</Badge>
          {a.nameCheck.result === "partial" && a.status === "pending" && <Badge variant="outline">Partly matches</Badge>}
        </div>
        <p className="text-sm text-muted-foreground">
          <span className="font-mono">{a.accountNumber}</span>, {a.bankName ?? "bank"}
        </p>
        <p className="text-sm text-muted-foreground">{note}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {a.status === "active" && sources.length > 0 && (
          <WithdrawDialog account={a} sources={sources}>
            <Button size="sm">Withdraw</Button>
          </WithdrawDialog>
        )}
        {canManage && (a.status === "active" || a.status === "pending") && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon-sm" variant="ghost" aria-label={`More for ${a.accountName}`} disabled={busy}>
                {busy ? <Spinner /> : <MoreHorizontal aria-hidden />}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {a.status === "pending" ? (
                <DropdownMenuItem onSelect={() => run(() => cancelSettlementAccount(a._id), "Cancelled. It won't be reviewed.")}>
                  Cancel
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() =>
                    run(
                      () => stepUp.confirm("settlement.remove", { id: a._id }, (proof) => removeSettlementAccount(a._id, proof)),
                      "Removed. Nothing more can be withdrawn to it.",
                    )
                  }
                >
                  Remove
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {stepUp.dialog}
    </li>
  )
}

function SettlementOnly({ security, canManage }: { security: SecurityState; canManage: boolean }) {
  const { settlementOnly } = security.moneyOut
  const removal = settlementOnly.removal
  const stepUp = useStepUp()
  const [busy, setBusy] = useState(false)

  async function run(promise: () => Promise<ActionResult<unknown> | null>, done: string) {
    setBusy(true)
    const result = await promise()
    setBusy(false)
    if (!result) return
    if (!result.ok) return toast.error(result.error)
    toast.success(done)
  }

  return (
    <section className="grid gap-4">
      <SectionHeading
        title="Settlement accounts only"
        description={`When on, money can leave only to your settlement accounts and between your own branches, so a stolen login can't send it anywhere else. Turning it off takes ${security.rules.settlementOnlyOffHours} hours and a LinkPay review.`}
        badge={<Badge variant={settlementOnly.enabled ? "success" : "muted"}>{settlementOnly.enabled ? "On" : "Off"}</Badge>}
      />
      {canManage && (
        <div className="flex flex-wrap items-center gap-3">
          {!settlementOnly.enabled && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                run(
                  () => stepUp.confirm("settlement_only.enable", {}, (proof) => enableSettlementOnly(proof)),
                  "On. Money can now leave only to your settlement accounts and between your branches.",
                )
              }
            >
              {busy && <Spinner />}
              Turn on
            </Button>
          )}
          {settlementOnly.enabled && !removal && !security.moneyOut.frozen && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                run(
                  () => stepUp.confirm("settlement_only.disable", {}, (proof) => requestSettlementOnlyOff(proof)),
                  "Asked. LinkPay will review it, and your team has been emailed.",
                )
              }
            >
              {busy && <Spinner />}
              Ask to turn off
            </Button>
          )}
          {removal && (
            <>
              <p className="text-sm text-muted-foreground">
                {removal.status === "approved" ? "LinkPay approved turning it off" : "Waiting for LinkPay to review turning it off"}. It goes off at{" "}
                {formatDateTime(removal.availableAt)} at the earliest.
              </p>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(() => cancelSettlementOnlyOff(), "Cancelled. It stays on.")}>
                Keep it on
              </Button>
            </>
          )}
        </div>
      )}
      {stepUp.dialog}
    </section>
  )
}

function Freeze({ security, canFreeze }: { security: SecurityState; canFreeze: boolean }) {
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)
  if (security.moneyOut.frozen) return null

  async function freeze() {
    setBusy(true)
    const result = await freezeMoneyOut(reason.trim() || undefined)
    setBusy(false)
    if (!result.ok) return toast.error(result.error)
    setReason("")
    toast.success("Frozen. Nothing can leave the business until it's unfrozen.")
  }

  return (
    <section className="grid gap-4">
      <SectionHeading
        title="Emergency freeze"
        description="If you think someone else is using a login on your team, freeze money out. Nothing can be sent, approved or withdrawn until the owner unfreezes it with a code. Money still comes in."
      />
      {canFreeze ? (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="destructive" className="justify-self-start">
              <Snowflake data-icon="inline-start" aria-hidden />
              Freeze money out
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Freeze money out?</AlertDialogTitle>
              <AlertDialogDescription>
                Transfers, approvals and withdrawals stop straight away, and anything approved but not yet sent is held. Your team is
                told. Settlement accounts waiting for review are cancelled.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <Field>
              <FieldLabel htmlFor="freeze-reason">What happened (optional)</FieldLabel>
              <Textarea id="freeze-reason" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={freeze} disabled={busy}>
                {busy && <Spinner />}
                Freeze
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : (
        <p className="text-sm text-muted-foreground">Ask the owner, an admin, or someone in finance to freeze it.</p>
      )}
    </section>
  )
}
