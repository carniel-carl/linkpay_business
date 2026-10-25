"use client"

import { useState, useTransition, type ReactNode } from "react"
import { LogOut } from "lucide-react"
import { toast } from "sonner"
import { leaveBusiness } from "@/app/(dashboard)/team/actions"
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
import { Spinner } from "@/components/ui/spinner"

/** For every member except the owner. Leaving takes them back to their own business, if they have one. */
export function LeaveBusiness({ businessId, businessName }: { businessId: string; businessName: string }) {
  return (
    <section
      aria-labelledby="leave-title"
      className="flex flex-wrap items-center justify-between gap-4 rounded-[18px] border border-dashed px-6 py-5 sm:px-8"
    >
      <div className="grid gap-1">
        <h2 id="leave-title" className="text-sm font-medium">
          Leave {businessName}
        </h2>
        <p className="text-sm text-muted-foreground">You&apos;ll lose access straight away. Only an invite can bring you back.</p>
      </div>
      <LeaveBusinessDialog businessId={businessId} businessName={businessName}>
        {/* Not a write gate: the API lets members leave a suspended or closed business (routes/team.ts). */}
        <Button variant="outline" className="text-destructive hover:text-destructive">
          <LogOut data-icon="inline-start" aria-hidden />
          Leave business
        </Button>
      </LeaveBusinessDialog>
    </section>
  )
}

/**
 * Asks before leaving `businessId`, then leaves it (team page and closed page). Leaving goes on to the member's
 * default business, or onboarding if there's none. `children` is the trigger.
 */
export function LeaveBusinessDialog({
  businessId,
  businessName,
  description = "You won't be able to see its accounts or branches any more. To come back, someone on the team will have to invite you again.",
  children,
}: {
  businessId: string
  businessName: string
  description?: string
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()

  function leave() {
    startTransition(async () => {
      // Redirects on success.
      const result = await leaveBusiness(businessId)
      if (!result.ok) toast.error(result.error)
    })
  }

  return (
    <AlertDialog open={open} onOpenChange={(next) => !pending && setOpen(next)}>
      <AlertDialogTrigger asChild>{children}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Leave {businessName}?</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Stay</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={pending}
            onClick={(e) => {
              e.preventDefault()
              leave()
            }}
          >
            {pending && <Spinner />}
            Leave business
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
