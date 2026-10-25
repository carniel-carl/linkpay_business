"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Ellipsis, Pencil, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import type { Beneficiary } from "@/lib/api/types"
import { DeleteDialog, RenameDialog } from "./beneficiaries-view"

/** "…" on a beneficiary's page: change the nickname, or delete it (then back to the list). */
export function BeneficiaryMenu({ beneficiary }: { beneficiary: Beneficiary }) {
  const router = useRouter()
  const [acting, setActing] = useState<"rename" | "delete" | null>(null)
  const name = beneficiary.nickname ?? beneficiary.accountName
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="icon" aria-label={`More actions for ${name}`}>
            <Ellipsis aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem write onSelect={() => setActing("rename")}>
            <Pencil aria-hidden />
            {beneficiary.nickname ? "Change nickname" : "Add a nickname"}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem write variant="destructive" onSelect={() => setActing("delete")}>
            <Trash2 aria-hidden />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <RenameDialog beneficiary={acting === "rename" ? beneficiary : null} onClose={() => setActing(null)} />
      <DeleteDialog
        beneficiary={acting === "delete" ? beneficiary : null}
        onClose={() => setActing(null)}
        onDeleted={() => router.push("/beneficiaries")}
      />
    </>
  )
}

/** "Change" beside the nickname on a beneficiary's page. */
export function NicknameEdit({ beneficiary }: { beneficiary: Beneficiary }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button
        write
        variant="ghost"
        size="sm"
        className="-my-1.5 h-7 px-2"
        aria-label={beneficiary.nickname ? "Change nickname" : "Add a nickname"}
        onClick={() => setOpen(true)}
      >
        {beneficiary.nickname ? "Change" : "Add"}
      </Button>
      <RenameDialog beneficiary={open ? beneficiary : null} onClose={() => setOpen(false)} />
    </>
  )
}
