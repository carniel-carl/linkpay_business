"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Ellipsis, ExternalLink, Pencil, Power, PowerOff, Trash2 } from "lucide-react"
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
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Spinner } from "@/components/ui/spinner"
import type { PaymentLink } from "@/lib/api/types"

/** Copy and edit up front; open, turn off or on, and delete in the menu. */
export function LinkActions({ link }: { link: PaymentLink }) {
  const router = useRouter()
  const [confirm, setConfirm] = useState<"off" | "delete" | null>(null)
  const [busy, setBusy] = useState(false)
  const active = link.status === "active"
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
      <Button variant="outline" asChild>
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
          {active ? (
            <DropdownMenuItem onSelect={() => setConfirm("off")}>
              <PowerOff aria-hidden />
              Turn off
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem disabled={busy} onSelect={() => setStatus("active")}>
              <Power aria-hidden />
              Turn on
            </DropdownMenuItem>
          )}
          {!used && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => setConfirm("delete")}>
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
    </>
  )
}
