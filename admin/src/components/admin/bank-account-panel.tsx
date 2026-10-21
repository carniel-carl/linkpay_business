"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { ChevronRight, Landmark, RotateCw } from "lucide-react"
import { toast } from "sonner"
import { retryAccountSetup } from "@/app/(console)/actions"
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
import type { Account, LiquifiaInfo } from "@/lib/api/types"
import type { BusinessStatus } from "@/lib/kyb"
import { AccountSetupBadge } from "./account-setup-badge"
import { AdminSection } from "./admin-section"

type Props = {
  businessId: string
  businessName: string
  businessStatus: BusinessStatus
  liquifia?: LiquifiaInfo
  account?: Account
  /** The staff role allows retrying account setup (accounts.provision). */
  canProvision: boolean
}

/** Admin view of the business's bank account and its setup with the banking partner. */
export function BankAccountPanel({ businessId, businessName, businessStatus, liquifia, account, canProvision }: Props) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const status = liquifia?.accountStatus ?? "not_started"
  const canRetry = canProvision && businessStatus === "approved" && status !== "active"

  function retry() {
    startTransition(async () => {
      const result = await retryAccountSetup(businessId)
      setOpen(false)
      if (result.ok) toast.success(`Account ready: ${result.data.accountNumber}`)
      else toast.error(result.error)
      router.refresh()
    })
  }

  return (
    <AdminSection id="bank-account" title="Head office account" aside={<AccountSetupBadge status={status} />}>
      <div className="grid gap-5">
        {account ? (
          <dl className="grid gap-4 text-sm sm:grid-cols-2">
            <div className="grid gap-0.5 sm:col-span-2">
              <dt className="text-xs text-muted-foreground">Account number</dt>
              <dd className="flex items-center gap-1">
                <span className="font-mono text-lg tracking-[0.04em]">{account.accountNumber}</span>
                <CopyButton value={account.accountNumber} message="Account number copied" label="Copy account number" />
              </dd>
            </div>
            <Row label="Account name" value={account.accountName} />
            <Row label="Bank" value={account.bankName} />
          </dl>
        ) : (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Landmark className="size-4" aria-hidden />
            {businessStatus === "approved" ? "No account yet." : "An account is created when the business is approved."}
          </p>
        )}

        {liquifia?.customerId && (
          <div className="grid gap-0.5 text-sm">
            <span className="text-xs text-muted-foreground">Partner customer ID</span>
            <span className="font-mono text-xs break-all">{liquifia.customerId}</span>
          </div>
        )}

        {status === "failed" && liquifia?.lastError && (
          <Collapsible>
            <CollapsibleTrigger className="group flex items-center gap-1 text-sm font-medium text-destructive">
              <ChevronRight className="size-4 transition-transform duration-200 group-data-[state=open]:rotate-90" aria-hidden />
              Last setup error
            </CollapsibleTrigger>
            <CollapsibleContent>
              <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all">
                {liquifia.lastError}
              </pre>
            </CollapsibleContent>
          </Collapsible>
        )}

        {canRetry && (
          <AlertDialog open={open} onOpenChange={setOpen}>
            <AlertDialogTrigger asChild>
              <Button variant="outline" size="sm" className="w-fit">
                <RotateCw data-icon="inline-start" aria-hidden />
                Retry account setup
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Retry account setup?</AlertDialogTitle>
                <AlertDialogDescription>
                  We&apos;ll ask the banking partner to open {businessName}&apos;s account again. It&apos;s safe to
                  repeat: if the account already exists, nothing new is created.
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
      </div>
    </AdminSection>
  )
}

function Row({ label, value }: { label: string; value?: string }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="break-words">{value || "Not provided"}</dd>
    </div>
  )
}
