"use client"

import { RotateCw, TriangleAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"

export function ErrorState({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const offline = /reach LinkPay/i.test(error.message)
  return (
    <Empty className="min-h-80 border border-dashed">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <TriangleAlert aria-hidden />
        </EmptyMedia>
        <EmptyTitle>{offline ? "We can't reach LinkPay" : "This page didn't load"}</EmptyTitle>
        <EmptyDescription>
          {offline
            ? "Check your internet connection, then try again."
            : "Something went wrong on our side. Try again, and if it keeps happening, contact support."}
          {error.digest && <span className="mt-2 block font-mono text-xs">Ref {error.digest}</span>}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button variant="outline" onClick={reset}>
          <RotateCw data-icon="inline-start" aria-hidden />
          Try again
        </Button>
      </EmptyContent>
    </Empty>
  )
}
