"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Send } from "lucide-react"
import { toast } from "sonner"
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
import { submitBusiness } from "../actions"

export function SubmitButton({
  disabled,
  businessName,
  resubmitting,
}: {
  disabled: boolean
  businessName: string
  resubmitting: boolean
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()

  function submit() {
    startTransition(async () => {
      const result = await submitBusiness()
      if (result.ok) {
        setOpen(false)
        router.push("/onboarding/status")
      } else {
        setOpen(false)
        toast.error(result.error, {
          description: result.missing?.length ? `Still missing: ${result.missing.map((m) => m.label).join(", ")}` : undefined,
        })
        router.refresh()
      }
    })
  }

  const label = resubmitting ? "Resubmit for review" : "Submit for review"
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button disabled={disabled}>
          <Send data-icon="inline-start" aria-hidden />
          {label}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Submit {businessName} for review?</AlertDialogTitle>
          <AlertDialogDescription>
            Our team usually reviews within 1 to 2 business days and will email you the outcome. You can&apos;t edit your
            details while we review.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Not yet</AlertDialogCancel>
          <AlertDialogAction
            disabled={pending}
            onClick={(e) => {
              e.preventDefault()
              submit()
            }}
          >
            {pending && <Spinner />}
            {label}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
