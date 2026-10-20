"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { ChevronRight, RotateCw, Store } from "lucide-react"
import { toast } from "sonner"
import { retryBranchAccountSetup } from "@/app/admin/actions"
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
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Spinner } from "@/components/ui/spinner"
import type { Branch } from "@/lib/api/types"
import { AccountSetupBadge } from "./account-setup-badge"
import { AdminSection } from "./admin-section"

/**
 * Admin view of a business's branches besides the head office (which the Bank account panel
 * covers): each branch's account and its setup, with a per-branch retry.
 */
export function BranchesPanel({ businessId, branches }: { businessId: string; branches: Branch[] }) {
  const others = branches.filter((b) => !b.isHeadOffice)

  return (
    <AdminSection
      id="branches"
      title="Other branches"
      flush
      aside={<span className="figure text-xs text-muted-foreground">{others.length} besides head office</span>}
    >
      {others.length === 0 ? (
        <p className="flex items-center gap-2 p-5 text-sm text-muted-foreground sm:px-6">
          <Store className="size-4" aria-hidden />
          No other branches yet.
        </p>
      ) : (
        <ul className="divide-y">
          {others.map((b) => (
            <BranchRow key={b._id} businessId={businessId} branch={b} />
          ))}
        </ul>
      )}
    </AdminSection>
  )
}

function BranchRow({ businessId, branch }: { businessId: string; branch: Branch }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const status = branch.liquifia?.accountStatus ?? "not_started"
  const place = [branch.address?.city, branch.address?.state].filter(Boolean).join(", ")

  function retry() {
    startTransition(async () => {
      const result = await retryBranchAccountSetup(businessId, branch._id)
      setOpen(false)
      if (result.ok) toast.success(`${branch.name} account ready: ${result.data.accountNumber}`)
      else toast.error(result.error)
      router.refresh()
    })
  }

  return (
    <li className="grid gap-3 px-5 py-4 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-0.5">
          <span className="font-medium">{branch.name}</span>
          <span className="text-xs text-muted-foreground">{place || "No address"}</span>
        </div>
        <AccountSetupBadge status={status} />
      </div>

      {branch.account && (
        <span className="flex items-center gap-1">
          <span className="font-mono tracking-[0.04em]">{branch.account.accountNumber}</span>
          <CopyButton value={branch.account.accountNumber} message="Account number copied" label={`Copy ${branch.name} account number`} />
        </span>
      )}

      {status === "failed" && branch.liquifia?.lastError && (
        <Collapsible>
          <CollapsibleTrigger className="group flex items-center gap-1 text-sm font-medium text-destructive">
            <ChevronRight className="size-4 transition-transform duration-200 group-data-[state=open]:rotate-90" aria-hidden />
            Last setup error
          </CollapsibleTrigger>
          <CollapsibleContent>
            <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap">
              {branch.liquifia.lastError}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      )}

      {!branch.account && (
        <AlertDialog open={open} onOpenChange={setOpen}>
          <AlertDialogTrigger asChild>
            <Button variant="outline" size="sm" className="w-fit">
              <RotateCw data-icon="inline-start" aria-hidden />
              Retry account setup
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Retry setup for {branch.name}?</AlertDialogTitle>
              <AlertDialogDescription>
                We&apos;ll ask the banking partner to open this branch&apos;s account again. It&apos;s safe to repeat: if
                the account already exists, nothing new is created.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={pending}
                onClick={(e) => {
                  e.preventDefault()
                  retry()
                }}
              >
                {pending && <Spinner />}
                Retry setup
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </li>
  )
}
