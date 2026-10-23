"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Ellipsis, Pencil, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { deletePayoutList } from "@/app/(dashboard)/payout-lists/actions"
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
import type { PayoutList } from "@/lib/api/types"

/**
 * Edit and delete for a payout list. Deleting moves no money, so it takes no PIN, but it asks first. On the list's
 * own page (`leaveTo`) it goes back to the lists afterwards.
 */
export function PayoutListMenu({ list, leaveTo, showEdit = true }: { list: Pick<PayoutList, "_id" | "title">; leaveTo?: string; showEdit?: boolean }) {
  const router = useRouter()
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)

  async function remove() {
    setBusy(true)
    const result = await deletePayoutList(list._id)
    setBusy(false)
    if (!result.ok) {
      setConfirming(false)
      return toast.error(result.error)
    }
    setConfirming(false)
    toast.success(`“${list.title}” is deleted. Its beneficiaries are still saved.`)
    if (leaveTo) router.push(leaveTo)
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="icon" aria-label={`More actions for ${list.title}`}>
            <Ellipsis aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          {showEdit && (
            <>
              <DropdownMenuItem asChild>
                <Link href={`/payout-lists/${list._id}/edit`}>
                  <Pencil aria-hidden />
                  Edit list
                </Link>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuItem variant="destructive" onSelect={() => setConfirming(true)}>
            <Trash2 aria-hidden />
            Delete list
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={confirming} onOpenChange={(o) => !o && !busy && setConfirming(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{list.title}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The list goes for good. The people on it stay saved as beneficiaries, and payments already made from it stay in Transfers.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={(e) => {
                e.preventDefault()
                remove()
              }}
            >
              {busy && <Spinner />}
              Delete list
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
