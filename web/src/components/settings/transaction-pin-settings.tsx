"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Lock, ShieldCheck, ShieldOff } from "lucide-react"
import { toast } from "sonner"
import { ChangePinForm, ResetPinForm, SetPinForm } from "@/components/transaction-pin/pin-forms"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import type { TransactionPinStatus } from "@/lib/api/types"
import { formatDate, formatDateTime } from "@/lib/format"

type Open = "set" | "change" | "reset" | null

/**
 * The transaction PIN: set it (password, then the PIN twice), change it (current PIN or password), or reset a
 * forgotten or locked one (an emailed code, the password and a new PIN). `status` is null when it couldn't be
 * loaded.
 */
export function TransactionPinSettings({ status, hasPassword }: { status: TransactionPinStatus | null; hasPassword: boolean }) {
  const router = useRouter()
  const [open, setOpen] = useState<Open>(null)
  // A wrong current PIN in Change can lock it; Reset then says until when.
  const [lockedUntil, setLockedUntil] = useState<string | null>(null)
  const close = () => setOpen(null)
  const locked = !!status?.locked
  const until = status?.lockedUntil ?? null

  return (
    <section id="transaction-pin" className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="grid gap-1">
          <h2 className="text-sm font-medium">Transaction PIN</h2>
          <p className="text-sm text-muted-foreground">4 digits that confirm transfers, approvals and team changes.</p>
        </div>
        {status &&
          (locked ? (
            <Badge variant="warning">
              <Lock data-icon="inline-start" aria-hidden />
              Locked
            </Badge>
          ) : status.isSet ? (
            <Badge variant="success">
              <ShieldCheck data-icon="inline-start" aria-hidden />
              Set
            </Badge>
          ) : (
            <Badge variant="warning">
              <ShieldOff data-icon="inline-start" aria-hidden />
              Not set
            </Badge>
          ))}
      </div>

      {!status ? (
        <p className="text-sm text-muted-foreground">We couldn&apos;t check your PIN just now. Refresh the page to try again.</p>
      ) : !status.isSet ? (
        hasPassword ? (
          <div className="grid gap-3">
            <p className="max-w-[65ch] text-sm text-muted-foreground">
              You&apos;ll need it to send money, approve transfers, take money out of savings and change your team or approval
              rules. Set it now with your password.
            </p>
            <Button size="sm" className="w-fit" onClick={() => setOpen("set")}>
              Set PIN
            </Button>
          </div>
        ) : (
          <p className="max-w-[65ch] text-sm text-muted-foreground">
            You need a password to set a PIN. Set one under Password above, then come back here.
          </p>
        )
      ) : (
        <div className="grid gap-3">
          {locked ? (
            <p className="flex items-start gap-2.5 rounded-xl bg-warning-subtle p-4 text-sm text-warning-foreground">
              <Lock className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>
                It was entered wrongly too many times, so it&apos;s locked{until ? ` until ${formatDateTime(until)}` : ""}. Reset it
                now with your password and a code we email you, or wait.
              </span>
            </p>
          ) : (
            <p className="max-w-[65ch] text-sm text-muted-foreground">
              {status.changedAt && `Last changed ${formatDate(status.changedAt)}. `}
              It&apos;s separate from your password, and the same in every business you&apos;re part of.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {!locked && (
              <Button variant="outline" size="sm" onClick={() => setOpen("change")}>
                Change PIN
              </Button>
            )}
            <Button
              variant={locked ? "default" : "ghost"}
              size="sm"
              onClick={() => {
                setLockedUntil(null)
                setOpen("reset")
              }}
            >
              {locked ? "Reset PIN" : "Forgot your PIN?"}
            </Button>
          </div>
        </div>
      )}

      <PinDialog
        open={open === "set"}
        onClose={close}
        title="Set your transaction PIN"
        description="Confirm your password, then choose 4 digits. Avoid repeated digits and runs like 1234."
      >
        <SetPinForm
          idPrefix="settings-set-pin"
          submitLabel="Set PIN"
          onCancel={close}
          onSet={() => {
            toast.success("Your transaction PIN is set.")
            close()
          }}
          onAlreadySet={() => {
            toast.info("You already have a transaction PIN.")
            close()
            router.refresh()
          }}
        />
      </PinDialog>
      <PinDialog
        open={open === "change"}
        onClose={close}
        title="Change your transaction PIN"
        description={
          hasPassword
            ? "Confirm it's you with your current PIN or your password, then choose a new one."
            : "Confirm it's you with your current PIN, then choose a new one."
        }
      >
        <ChangePinForm
          idPrefix="settings-change-pin"
          submitLabel="Change PIN"
          hasPassword={hasPassword}
          onCancel={close}
          onChanged={() => {
            toast.success("Your transaction PIN is changed.")
            close()
          }}
          onLocked={(lockedAt) => {
            setLockedUntil(lockedAt)
            setOpen("reset")
            router.refresh()
          }}
        />
      </PinDialog>
      <PinDialog
        open={open === "reset"}
        onClose={close}
        title="Reset your transaction PIN"
        description={
          lockedUntil
            ? `That was the last try, so your PIN is locked until ${formatDateTime(lockedUntil)}. Reset it now with your password and a code we email you.`
            : "Use a code we email you and your password, then choose a new PIN. This also ends a lock."
        }
      >
        <ResetPinForm
          idPrefix="settings-reset-pin"
          submitLabel="Reset PIN"
          onCancel={close}
          onReset={() => {
            toast.success("Your transaction PIN is reset.")
            close()
          }}
        />
      </PinDialog>
    </section>
  )
}

function PinDialog({
  open,
  onClose,
  title,
  description,
  children,
}: {
  open: boolean
  onClose: () => void
  title: string
  description: string
  children: React.ReactNode
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {/* Mounted only while open, so every visit starts empty. */}
        {open && children}
      </DialogContent>
    </Dialog>
  )
}
