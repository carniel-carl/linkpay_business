"use client"

import { useState, useTransition } from "react"
import { Check, Copy, Download, TriangleAlert } from "lucide-react"
import { toast } from "sonner"
import { newRecoveryCodes } from "@/app/(console)/security/actions"
import { CodeInput } from "@/components/auth/code-input"
import { PasswordInput } from "@/components/auth/password-input"
import { FormError } from "@/components/common/form-error"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldError, FieldLabel } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import { FEW_RECOVERY_CODES, recoveryCodesFile } from "@/lib/recovery-codes"
import { cn } from "@/lib/utils"

/**
 * The codes, shown once: a monospace grid, Copy all, Download and "I've saved them". They live only in the
 * state of whatever opened this, and are gone when it closes.
 */
export function RecoveryCodesView({ codes, email, onDone }: { codes: string[]; email: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false)

  async function copyAll() {
    try {
      await navigator.clipboard.writeText(codes.join("\n"))
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error("Couldn't copy. Select the codes and copy them instead.")
    }
  }

  function download() {
    const url = URL.createObjectURL(new Blob([recoveryCodesFile(codes, email)], { type: "text/plain;charset=utf-8" }))
    const a = document.createElement("a")
    a.href = url
    a.download = "linkpay-staff-recovery-codes.txt"
    document.body.append(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return (
    <div className="grid gap-6">
      <p className="text-sm text-muted-foreground">
        If you can&apos;t use your authenticator app, for example after losing your phone, sign in to the staff console with
        one of these instead of a code. Each code works once. Keep them somewhere safe, like a password manager. We
        won&apos;t show them again.
      </p>
      <ol
        aria-label="Recovery codes"
        className="grid grid-cols-2 gap-x-6 gap-y-2 rounded-xl border bg-muted/50 px-5 py-4 font-mono text-sm tracking-wide"
      >
        {codes.map((c) => (
          <li key={c} className="select-all">
            {c}
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={copyAll}>
          {copied ? <Check data-icon="inline-start" className="text-primary" aria-hidden /> : <Copy data-icon="inline-start" aria-hidden />}
          {copied ? "Copied" : "Copy all"}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={download}>
          <Download data-icon="inline-start" aria-hidden />
          Download
        </Button>
      </div>
      <DialogFooter>
        <Button type="button" onClick={onDone}>
          I&apos;ve saved them
        </Button>
      </DialogFooter>
    </div>
  )
}

/** Settings while the authenticator app is in use: how many codes are left, and new ones. */
export function RecoveryCodesSection({ left, email }: { left: number; email: string }) {
  const [open, setOpen] = useState(false)
  const few = left <= FEW_RECOVERY_CODES

  return (
    <section id="recovery-codes" className="grid scroll-mt-24 gap-3 border-t pt-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="grid gap-1">
          <h2 className="text-sm font-medium">Recovery codes</h2>
          <p className="text-sm text-muted-foreground">
            For when you can&apos;t use your authenticator app. Each code works once.
          </p>
        </div>
        <Badge variant={left === 0 ? "destructive" : few ? "warning" : "muted"} className="figure">
          {left} left
        </Badge>
      </div>
      {left === 0 ? (
        <p className="flex items-start gap-2.5 rounded-xl bg-destructive-subtle p-4 text-sm text-destructive">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            You have no recovery codes left. If you lose your phone, you won&apos;t be able to sign in. Get new codes now.
          </span>
        </p>
      ) : (
        few && (
          <p className="flex items-start gap-2.5 rounded-xl bg-warning-subtle p-4 text-sm text-warning-foreground">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>Only {left} left. Get new codes before you run out.</span>
          </p>
        )
      )}
      <Button variant={few ? "default" : "outline"} size="sm" className="w-fit" onClick={() => setOpen(true)}>
        Get new codes
      </Button>
      <NewCodesDialog open={open} onClose={() => setOpen(false)} email={email} />
    </section>
  )
}

function NewCodesDialog({ open, onClose, email }: { open: boolean; onClose: () => void; email: string }) {
  const [codes, setCodes] = useState<string[] | null>(null)
  // While the new codes are on screen, only "I've saved them" closes this: they can't be shown again.
  const keepOpen = (e: Event) => {
    if (codes) e.preventDefault()
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !codes && onClose()}>
      <DialogContent className="sm:max-w-md" showCloseButton={!codes} onInteractOutside={keepOpen} onEscapeKeyDown={keepOpen}>
        {codes ? (
          <>
            <DialogHeader>
              <DialogTitle>Save your new recovery codes</DialogTitle>
              <DialogDescription>Your old codes no longer work.</DialogDescription>
            </DialogHeader>
            <RecoveryCodesView
              codes={codes}
              email={email}
              onDone={() => {
                setCodes(null)
                onClose()
              }}
            />
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Get new recovery codes</DialogTitle>
              <DialogDescription>Confirm it&apos;s you with your password or a code from your authenticator app.</DialogDescription>
            </DialogHeader>
            {/* Mounted only while open, so every attempt starts empty. */}
            {open && <NewCodesForm onCodes={setCodes} onCancel={onClose} />}
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

type Proof = "password" | "code"
type ProofError = { field?: Proof; message: string }

function NewCodesForm({ onCodes, onCancel }: { onCodes: (codes: string[]) => void; onCancel: () => void }) {
  const [proof, setProof] = useState<Proof>("password")
  const [password, setPassword] = useState("")
  const [code, setCode] = useState("")
  const [error, setError] = useState<ProofError>()
  const [pending, startTransition] = useTransition()

  function submit(value = code) {
    if (proof === "password" && !password) return setError({ field: "password", message: "Enter your password." })
    if (proof === "code" && value.length !== 6) return setError({ field: "code", message: "Enter the 6-digit code from the app." })
    setError(undefined)
    startTransition(async () => {
      const result = await newRecoveryCodes(proof === "password" ? { password } : { code: value })
      if (result.ok) return onCodes(result.data.recoveryCodes)
      if (result.code === "INCORRECT_PASSWORD" || result.error === "That password is incorrect.") {
        return setError({ field: "password", message: "That password is incorrect." })
      }
      if (result.code === "INVALID_CODE") {
        setCode("")
        return setError({ field: "code", message: "That code didn't match. Wait for a new code in the app and try again." })
      }
      setError({ message: result.error })
    })
  }

  return (
    <form
      className="grid gap-6"
      noValidate
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <p className="flex items-start gap-2.5 rounded-xl bg-warning-subtle p-4 text-sm text-warning-foreground">
        <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span>Your current recovery codes stop working as soon as you get new ones.</span>
      </p>
      <FormError message={error && !error.field ? error.message : undefined} />
      <div role="radiogroup" aria-label="Confirm it's you with" className="inline-flex h-9 w-fit items-center gap-0.5 rounded-full bg-muted p-0.5">
        {(["password", "code"] as const).map((v) => (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={proof === v}
            onClick={() => {
              setProof(v)
              setError(undefined)
            }}
            className={cn(
              "h-8 rounded-full px-4 text-sm font-medium transition-colors duration-150 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
              proof === v ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {v === "password" ? "Password" : "Authenticator code"}
          </button>
        ))}
      </div>
      {proof === "password" ? (
        <Field data-invalid={error?.field === "password"}>
          <FieldLabel htmlFor="recovery-password">Password</FieldLabel>
          <PasswordInput
            id="recovery-password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={error?.field === "password"}
          />
          {error?.field === "password" && <FieldError>{error.message}</FieldError>}
        </Field>
      ) : (
        <Field data-invalid={error?.field === "code"}>
          <FieldLabel htmlFor="recovery-totp-code">Code from the app</FieldLabel>
          <CodeInput
            id="recovery-totp-code"
            value={code}
            onChange={setCode}
            onComplete={submit}
            disabled={pending}
            invalid={error?.field === "code"}
          />
          {error?.field === "code" && <FieldError>{error.message}</FieldError>}
        </Field>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending || (proof === "code" && code.length !== 6)}>
          {pending && <Spinner />}
          Get new codes
        </Button>
      </DialogFooter>
    </form>
  )
}
