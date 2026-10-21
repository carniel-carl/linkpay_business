"use client"

import { useTransition } from "react"
import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"

type Patch = Record<string, string | undefined>

/**
 * Lists that keep their filters in the URL. `hrefWith` builds a link with `patch` merged in (undefined or
 * "" removes a key); `navigate` goes there in a transition, so `pending` can dim the current results.
 */
export function useUrlState() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [pending, startTransition] = useTransition()

  function hrefWith(patch: Patch) {
    const params = new URLSearchParams(searchParams.toString())
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || value === "") params.delete(key)
      else params.set(key, value)
    }
    const qs = params.toString()
    return qs ? `${pathname}?${qs}` : pathname
  }

  function navigate(patch: Patch) {
    startTransition(() => router.push(hrefWith(patch), { scroll: false }))
  }

  return { searchParams, hrefWith, navigate, pending }
}

/** "26 to 50 of 140 payments" with previous and next. Pages are 1-based and live in ?page=. */
export function Pager({ total, page, pageSize, noun }: { total: number; page: number; pageSize: number; noun: string }) {
  const { hrefWith } = useUrlState()
  if (total === 0) return null
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const from = (page - 1) * pageSize + 1
  const to = Math.min(total, page * pageSize)
  const link = (p: number) => hrefWith({ page: p <= 1 ? undefined : String(p) })

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-t px-4 py-3 text-sm sm:px-6">
      <p role="status" aria-live="polite" className="figure text-muted-foreground">
        {from > total ? `Nothing on page ${page}` : `${from} to ${to} of ${total} ${noun}`}
      </p>
      <nav aria-label="Pagination" className="flex items-center gap-3">
        <span className="figure text-muted-foreground">
          Page {Math.min(page, pages)} of {pages}
        </span>
        <div className="flex gap-1">
          {page > 1 ? (
            <Button variant="outline" size="icon-sm" asChild>
              <Link href={link(page - 1)} scroll={false} aria-label="Previous page">
                <ChevronLeft aria-hidden />
              </Link>
            </Button>
          ) : (
            <Button variant="outline" size="icon-sm" disabled aria-label="Previous page">
              <ChevronLeft aria-hidden />
            </Button>
          )}
          {page < pages ? (
            <Button variant="outline" size="icon-sm" asChild>
              <Link href={link(page + 1)} scroll={false} aria-label="Next page">
                <ChevronRight aria-hidden />
              </Link>
            </Button>
          ) : (
            <Button variant="outline" size="icon-sm" disabled aria-label="Next page">
              <ChevronRight aria-hidden />
            </Button>
          )}
        </div>
      </nav>
    </div>
  )
}
