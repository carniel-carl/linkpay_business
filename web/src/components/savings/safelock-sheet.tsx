"use client"

import { useState } from "react"
import { Lock, Pencil } from "lucide-react"
import { toast } from "sonner"
import { renameSafelock } from "@/app/(dashboard)/savings/actions"
import { FormError } from "@/components/common/form-error"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Spinner } from "@/components/ui/spinner"
import type { Safelock } from "@/lib/api/types"
import { formatDate, formatNaira } from "@/lib/format"
import { daysLeftLabel, formatDay } from "@/lib/savings"
import { LockProgress, SafelockTile } from "./safelock-parts"

/** One Safelock: amount, dates, time left and rename. There is deliberately no way to take the money out. */
export function SafelockSheet({ safelock, onClose }: { safelock: Safelock | null; onClose: () => void }) {
  return (
    <Sheet open={!!safelock} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="gap-0 overflow-y-auto p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-md">
        {safelock && <Details key={safelock._id} lock={safelock} />}
      </SheetContent>
    </Sheet>
  )
}

function Details({ lock: s }: { lock: Safelock }) {
  const [renaming, setRenaming] = useState(false)
  const released = s.status === "released"

  return (
    <>
      <SheetHeader className="gap-5 border-b bg-muted/50 p-6 pr-14">
        <div className="flex items-center gap-3">
          <SafelockTile released={released} />
          {released ? <Badge variant="success">Unlocked</Badge> : <Badge variant="outline">Locked</Badge>}
        </div>
        <div className="grid gap-1.5">
          <SheetDescription className="text-foreground">
            <span className="font-display text-lg font-semibold tracking-[-0.02em]">{s.title}</span>
            {s.branch && <span className="text-muted-foreground">, {s.branch.name}</span>}
          </SheetDescription>
          <SheetTitle className="type-display text-4xl font-normal figure">
            <span className="sr-only">{s.title}: </span>
            {formatNaira(s.amountKobo)}
          </SheetTitle>
        </div>
        {!released && (
          <div className="grid gap-2">
            <LockProgress bps={s.progressBps} label="Time locked so far" className="h-2" />
            <p className="flex justify-between gap-3 text-xs text-muted-foreground">
              <span>{daysLeftLabel(s.daysLeft)}</span>
              <span>Unlocks {formatDay(s.unlockOn)}</span>
            </p>
          </div>
        )}
      </SheetHeader>

      {renaming && <RenameForm lock={s} onDone={() => setRenaming(false)} />}

      <dl className="grid gap-4 border-b p-6 text-sm">
        <Row label="Locked on">{formatDay(s.lockedOn)}</Row>
        <Row label={released ? "Unlocked on" : "Unlocks on"}>
          <span className="grid justify-items-end">
            <span>{formatDay(s.unlockOn)}</span>
            {!released && <span className="text-xs text-muted-foreground">at midnight, Lagos time</span>}
          </span>
        </Row>
        <Row label="Length">{s.totalDays.toLocaleString("en-NG")} days</Row>
        {s.branch && <Row label="Branch">{s.branch.name}</Row>}
        <Row label="Locked by">{s.createdBy?.name ?? <span className="text-muted-foreground">Unknown</span>}</Row>
        {s.releasedAt && <Row label="Back in the balance">{formatDate(s.releasedAt)}</Row>}
      </dl>

      <div className="grid gap-4 p-6">
        <p className="flex items-start gap-2.5 rounded-xl bg-muted/70 p-4 text-sm text-muted-foreground">
          <Lock className="mt-0.5 size-4 shrink-0" aria-hidden />
          {released ? (
            <span>
              This money went back into {s.branch?.name ?? "the branch"}&apos;s available balance when it unlocked.
            </span>
          ) : (
            <span>
              Nobody can take this money out, add to it or change the date. On {formatDay(s.unlockOn)} it goes back into{" "}
              {s.branch?.name ?? "the branch"}&apos;s available balance by itself.
            </span>
          )}
        </p>
        {s.canRename && !renaming && (
          <Button variant="ghost" size="sm" className="w-fit" onClick={() => setRenaming(true)}>
            <Pencil data-icon="inline-start" aria-hidden />
            Rename
          </Button>
        )}
      </div>
    </>
  )
}

function RenameForm({ lock, onDone }: { lock: Safelock; onDone: () => void }) {
  const [title, setTitle] = useState(lock.title)
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim()) return setError("Give the Safelock a name.")
    if (title.trim() === lock.title) return onDone()
    setBusy(true)
    const result = await renameSafelock(lock._id, title)
    setBusy(false)
    if (!result.ok) return setError(result.error)
    toast.success("Safelock renamed.")
    onDone()
  }

  return (
    <form onSubmit={submit} noValidate className="grid gap-3 border-b bg-card p-6">
      <FormError message={error} />
      <Field>
        <FieldLabel htmlFor="safelock-rename">Name</FieldLabel>
        <Input id="safelock-rename" autoFocus maxLength={40} value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy}>
          {busy && <Spinner />}
          Save name
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onDone} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
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
