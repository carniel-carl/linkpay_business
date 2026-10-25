"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { BellRing, Copy, Download, Ellipsis, FilePenLine, Files, Link2, Send, Trash2, Ban } from "lucide-react"
import { toast } from "sonner"
import { actOnInvoice, deleteDraft, sendInvoice } from "@/app/(dashboard)/invoices/actions"
import { FormError } from "@/components/common/form-error"
import { WriteGate } from "@/components/shell/write-gate"
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
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import type { Invoice } from "@/lib/api/types"
import { formatNaira } from "@/lib/format"
import { formatDay } from "@/lib/invoices"

const copy = async (url: string) => {
  try {
    await navigator.clipboard.writeText(url)
    toast.success("Link copied. Paste it into WhatsApp, SMS or an email.")
  } catch {
    toast.error("We couldn't copy the link. Select it and copy it yourself.")
  }
}

/** Send, share, download and the rarer actions in a menu. What shows depends on the status. */
export function InvoiceActions({ invoice }: { invoice: Invoice }) {
  const router = useRouter()
  const [sendOpen, setSendOpen] = useState(false)
  const [confirm, setConfirm] = useState<"void" | "delete" | null>(null)
  const [busy, setBusy] = useState(false)

  const draft = invoice.status === "draft"
  const unpaid = invoice.status === "open" || invoice.status === "partially_paid"
  const editable = draft || unpaid
  const pdf = `/api/files/invoices/${invoice._id}${invoice.status === "paid" ? "?receipt&download" : "?download"}`

  /** A draft has no link yet: marking it sent (without an email) creates it. */
  async function shareLink() {
    let url = invoice.publicUrl
    if (!url) {
      setBusy(true)
      const result = await sendInvoice(invoice._id, { email: false })
      setBusy(false)
      if (!result.ok) return toast.error(result.error)
      url = result.data.publicUrl
    }
    if (url) await copy(url)
  }

  async function act(action: "remind" | "duplicate" | "void") {
    setBusy(true)
    const result = await actOnInvoice(invoice._id, action)
    setBusy(false)
    if (!result.ok) return toast.error(result.error)
    if (action === "duplicate") {
      toast.success(`Copied to a new draft, ${result.data.number}.`)
      router.push(`/invoices/${result.data._id}/edit`)
    } else if (action === "remind") {
      toast.success(`Reminder sent to ${invoice.customer.email}.`)
    } else {
      toast.success(`${invoice.number} is void. The link now shows it's cancelled.`)
    }
    setConfirm(null)
  }

  async function remove() {
    setBusy(true)
    const result = await deleteDraft(invoice._id)
    setBusy(false)
    if (!result.ok) return toast.error(result.error)
    toast.success(`Draft ${invoice.number} deleted.`)
    router.push("/invoices")
  }

  return (
    <>
      {editable && (
        // Disabled, with the reason, while the business is suspended. The rest (link, PDF) are reads.
        <WriteGate>
          <Button onClick={() => setSendOpen(true)}>
            <Send data-icon="inline-start" aria-hidden />
            {invoice.lastSentAt ? "Send again" : "Send"}
          </Button>
        </WriteGate>
      )}
      {invoice.status !== "void" && (
        <Button variant="outline" disabled={busy} onClick={shareLink}>
          {busy ? <Spinner /> : <Link2 data-icon="inline-start" aria-hidden />}
          {draft ? "Get link" : "Copy link"}
        </Button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="icon" aria-label="More actions">
            <Ellipsis aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem asChild>
            <a href={pdf} download>
              <Download aria-hidden />
              {invoice.status === "paid" ? "Download receipt" : "Download PDF"}
            </a>
          </DropdownMenuItem>
          {editable && (
            <DropdownMenuItem asChild>
              <Link href={`/invoices/${invoice._id}/edit`}>
                <FilePenLine aria-hidden />
                Edit
              </Link>
            </DropdownMenuItem>
          )}
          {unpaid && invoice.customer.email && (
            <DropdownMenuItem disabled={busy} onSelect={() => act("remind")}>
              <BellRing aria-hidden />
              Send a reminder
            </DropdownMenuItem>
          )}
          <DropdownMenuItem disabled={busy} onSelect={() => act("duplicate")}>
            <Files aria-hidden />
            Duplicate
          </DropdownMenuItem>
          {invoice.publicUrl && invoice.status !== "void" && (
            <DropdownMenuItem onSelect={() => copy(invoice.publicUrl!)}>
              <Copy aria-hidden />
              Copy customer link
            </DropdownMenuItem>
          )}
          {(unpaid && invoice.payments.length === 0) || draft ? <DropdownMenuSeparator /> : null}
          {unpaid && invoice.payments.length === 0 && (
            <DropdownMenuItem variant="destructive" onSelect={() => setConfirm("void")}>
              <Ban aria-hidden />
              Void invoice
            </DropdownMenuItem>
          )}
          {draft && (
            <DropdownMenuItem variant="destructive" onSelect={() => setConfirm("delete")}>
              <Trash2 aria-hidden />
              Delete draft
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <SendDialog invoice={invoice} open={sendOpen} onOpenChange={setSendOpen} />

      <AlertDialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm === "void" ? `Void ${invoice.number}?` : `Delete draft ${invoice.number}?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === "void"
                ? "The invoice stays in your records, marked void, and the customer's link shows it's cancelled. Reminders stop. This can't be undone."
                : "Your customer has never seen it. The invoice number isn't reused."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Keep it</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={(e) => {
                e.preventDefault()
                if (confirm === "void") act("void")
                else remove()
              }}
            >
              {busy && <Spinner />}
              {confirm === "void" ? "Void invoice" : "Delete draft"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function SendDialog({ invoice, open, onOpenChange }: { invoice: Invoice; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [to, setTo] = useState(invoice.customer.email ?? "")
  const [message, setMessage] = useState("")
  const [error, setError] = useState<string>()
  const [toError, setToError] = useState<string>()
  const [busy, setBusy] = useState(false)

  async function send(e: React.FormEvent) {
    e.preventDefault()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to.trim())) return setToError("Enter the email address to send it to.")
    setToError(undefined)
    setBusy(true)
    setError(undefined)
    const result = await sendInvoice(invoice._id, { email: true, to: to.trim(), message: message.trim() || undefined })
    setBusy(false)
    if (!result.ok) return setError(result.error)
    toast.success(`${invoice.number} sent to ${to.trim()}.`)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Send {invoice.number}</DialogTitle>
          <DialogDescription>
            {invoice.customer.name} gets an email from {"you"} with a link to pay <span className="figure">{formatNaira(invoice.balanceKobo)}</span> by{" "}
            {formatDay(invoice.dueDate)}, and the PDF attached. Replies come to your business email.
          </DialogDescription>
        </DialogHeader>
        <FormError message={error} />
        <form id="send-invoice" onSubmit={send} noValidate className="grid gap-5">
          <Field data-invalid={!!toError}>
            <FieldLabel htmlFor="send-to">To</FieldLabel>
            <Input id="send-to" type="email" autoComplete="off" value={to} aria-invalid={!!toError} onChange={(e) => setTo(e.target.value)} />
            {toError && <FieldError>{toError}</FieldError>}
          </Field>
          <Field>
            <FieldLabel htmlFor="send-message">Message</FieldLabel>
            <Textarea
              id="send-message"
              rows={3}
              maxLength={1000}
              placeholder={`Hi ${invoice.customer.name.split(" ")[0]}, here's your invoice. Thank you for your business.`}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
            <FieldDescription>Optional. Shown above the invoice details.</FieldDescription>
          </Field>
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form="send-invoice" disabled={busy}>
            {busy && <Spinner />}
            Send invoice
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
