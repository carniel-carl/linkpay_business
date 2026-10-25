"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Ellipsis, ExternalLink, FlaskConical, Pencil, Power, PowerOff, Rocket, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { deletePaymentLink, updatePaymentLink } from "@/app/(dashboard)/payment-links/actions"
import { CopyButton } from "@/components/accounts/copy-button"
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
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Spinner } from "@/components/ui/spinner"
import type { PaymentLink, PaymentMode } from "@/lib/api/types"

const MODE_COPY: Record<PaymentMode, { title: string; description: string; action: string; done: string }> = {
  live: {
    title: "Take real payments?",
    description:
      "New customers see your branch's real account and their transfers are matched as usual. The link, QR code and embed code stay the same. Test payments made so far are cleared from the link's lists, totals and page.",
    action: "Go live",
    done: "Your payment link is live. New payments are real.",
  },
  test: {
    title: "Switch this link to test mode?",
    description:
      "New customers see placeholder bank details and can only simulate a payment, so no money comes in through this link until you go live again. Anyone already paying keeps their real details.",
    action: "Switch to test mode",
    done: "The link is in test mode. New payments are simulated.",
  },
}

/** Asks before switching a link between live and test, then saves. */
function useModeSwitch(link: PaymentLink) {
  const [target, setTarget] = useState<PaymentMode | null>(null)
  const [busy, setBusy] = useState(false)

  async function save() {
    if (!target) return
    setBusy(true)
    const result = await updatePaymentLink(link._id, { mode: target })
    setBusy(false)
    if (!result.ok) return toast.error(result.error)
    toast.success(MODE_COPY[target].done)
    setTarget(null)
  }

  const dialog = (
    <AlertDialog open={!!target} onOpenChange={(o) => !o && setTarget(null)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{target && MODE_COPY[target].title}</AlertDialogTitle>
          <AlertDialogDescription>{target && MODE_COPY[target].description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            onClick={(e) => {
              e.preventDefault()
              save()
            }}
          >
            {busy && <Spinner />}
            {target && MODE_COPY[target].action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
  return { ask: setTarget, dialog }
}

/** Above a test link's page: what test mode means, and (for members who manage links) "Go live". */
export function TestModeBanner({ link }: { link: PaymentLink }) {
  const mode = useModeSwitch(link)
  if (link.mode !== "test") return null
  return (
    <Alert className="gap-x-3 rounded-2xl border-0 bg-warning-subtle/60 px-5 py-4 text-warning-foreground shadow-surface">
      <FlaskConical aria-hidden />
      <AlertTitle className="font-semibold">This link is in test mode</AlertTitle>
      <AlertDescription className="text-warning-foreground">
        Customers see placeholder bank details and can simulate the payment, so you can try the page and your website&apos;s pay button.
        No money moves. Test payments show apart from real ones and are cleared when you go live.
      </AlertDescription>
      {link.canManage && (
        <Button write size="sm" onClick={() => mode.ask("live")} className="col-start-2 mt-2.5 justify-self-start">
          <Rocket data-icon="inline-start" aria-hidden />
          Go live
        </Button>
      )}
      {mode.dialog}
    </Alert>
  )
}

/** Copy and edit up front; open, live or test, turn off or on, and delete in the menu. */
export function LinkActions({ link }: { link: PaymentLink }) {
  const router = useRouter()
  const [confirm, setConfirm] = useState<"off" | "delete" | null>(null)
  const [busy, setBusy] = useState(false)
  const mode = useModeSwitch(link)
  const active = link.status === "active"
  // Test payments don't stop a link being deleted (they go with it).
  const used = link.paymentsCount > 0

  async function setStatus(status: "active" | "inactive") {
    setBusy(true)
    const result = await updatePaymentLink(link._id, { status })
    setBusy(false)
    if (!result.ok) return toast.error(result.error)
    setConfirm(null)
    toast.success(status === "active" ? "The link is taking payments again." : "The link is off. Its page now says it isn't taking payments.")
  }

  async function remove() {
    setBusy(true)
    const result = await deletePaymentLink(link._id)
    setBusy(false)
    if (!result.ok) {
      setConfirm(null)
      return toast.error(result.error)
    }
    toast.success("Payment link deleted.")
    router.push("/payment-links")
  }

  return (
    <>
      <CopyButton value={link.url} message="Link copied. Paste it into WhatsApp, SMS or an email." label="Copy link" variant="default" size="default">
        Copy link
      </CopyButton>
      {/* `write`: disabled, with the reason, while the business is suspended. Copying and opening the link still work. */}
      <Button write variant="outline" asChild>
        <Link href={`/payment-links/${link._id}/edit`}>
          <Pencil data-icon="inline-start" aria-hidden />
          Edit
        </Link>
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="icon" aria-label="More actions">
            <Ellipsis aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem asChild>
            <a href={link.url} target="_blank" rel="noopener noreferrer">
              <ExternalLink aria-hidden />
              Open the page
            </a>
          </DropdownMenuItem>
          {link.mode === "test" ? (
            <DropdownMenuItem write onSelect={() => mode.ask("live")}>
              <Rocket aria-hidden />
              Go live
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem write onSelect={() => mode.ask("test")}>
              <FlaskConical aria-hidden />
              Switch to test mode
            </DropdownMenuItem>
          )}
          {active ? (
            <DropdownMenuItem write onSelect={() => setConfirm("off")}>
              <PowerOff aria-hidden />
              Turn off
            </DropdownMenuItem>
          ) : (
            // A link LinkPay paused can only be turned back on by LinkPay.
            !link.takenDown && (
              <DropdownMenuItem write disabled={busy} onSelect={() => setStatus("active")}>
                <Power aria-hidden />
                Turn on
              </DropdownMenuItem>
            )
          )}
          {!used && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem write variant="destructive" onSelect={() => setConfirm("delete")}>
                <Trash2 aria-hidden />
                Delete
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm === "delete" ? "Delete this payment link?" : "Turn this link off?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === "delete"
                ? "Its address stops working for good. Only links nobody has started paying through can be deleted."
                : "Nobody new can start paying. Anyone already paying keeps their details, and their transfers are still matched. You can turn it back on at any time."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant={confirm === "delete" ? "destructive" : "default"}
              disabled={busy}
              onClick={(e) => {
                e.preventDefault()
                if (confirm === "delete") remove()
                else setStatus("inactive")
              }}
            >
              {busy && <Spinner />}
              {confirm === "delete" ? "Delete link" : "Turn off"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {mode.dialog}
    </>
  )
}
