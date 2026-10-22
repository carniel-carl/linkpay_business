"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { useVirtualizer } from "@tanstack/react-virtual"
import { EyeOff, HandHeart } from "lucide-react"
import { loadLinkDonors } from "@/app/(dashboard)/payment-links/actions"
import { Badge } from "@/components/ui/badge"
import { Spinner } from "@/components/ui/spinner"
import type { LinkCheckout, LinkCheckoutList } from "@/lib/api/types"
import { formatNaira, initials, timeAgo } from "@/lib/format"
import { cn } from "@/lib/utils"
import { TestBadge } from "./parts"

const ROW_ESTIMATE = 72
const PREFETCH_ROWS = 8

/**
 * Everyone who gave through a donation link, newest first, as the team sees them: real names (with a tag
 * when the donor is anonymous on the page), messages, and donations LinkPay took off the page. Only the rows
 * on screen are drawn; more load as you scroll. A row opens the payment's sheet.
 */
export function DonorsPanel({ linkId, initial, mode = "live" }: { linkId: string; initial: LinkCheckoutList; mode?: "live" | "test" }) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [items, setItems] = useState(initial.items)
  const [total, setTotal] = useState(initial.total)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const hasMore = items.length < total
  const scrollRef = useRef<HTMLDivElement>(null)

  const loadMore = useCallback(async () => {
    if (loading || !hasMore) return
    setLoading(true)
    const result = await loadLinkDonors(linkId, items.length, mode)
    setLoading(false)
    if (!result.ok) return setError(true)
    setError(false)
    setTotal(result.data.total)
    setItems((current) => {
      const known = new Set(current.map((c) => c._id))
      return [...current, ...result.data.items.filter((c) => !known.has(c._id))]
    })
  }, [hasMore, items.length, linkId, loading, mode])

  const count = items.length + (hasMore ? 1 : 0)
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_ESTIMATE,
    getItemKey: (index) => items[index]?._id ?? "more",
    overscan: 8,
  })
  const rows = virtualizer.getVirtualItems()
  const lastIndex = rows.at(-1)?.index ?? -1

  useEffect(() => {
    if (hasMore && !loading && !error && lastIndex >= items.length - PREFETCH_ROWS) void loadMore()
  }, [error, hasMore, items.length, lastIndex, loadMore, loading])

  const open = (c: LinkCheckout) => {
    const params = new URLSearchParams(searchParams.toString())
    params.set("checkout", c._id)
    router.push(`${pathname}?${params}`, { scroll: false })
  }

  return (
    <section aria-labelledby="donors-title" className="surface overflow-hidden">
      <header className="flex items-baseline justify-between gap-3 px-6 pt-6 pb-4 sm:px-8">
        <h2 id="donors-title" className="type-display text-xl">
          Donors <span className="figure text-muted-foreground">{total.toLocaleString("en-NG")}</span>
        </h2>
        <p className="text-xs text-muted-foreground">Names are shown to your team even when the donor is anonymous on the page.</p>
      </header>
      {items.length === 0 ? (
        <div className="grid justify-items-start gap-2 border-t px-6 py-8 sm:px-8">
          <span className="grid size-10 place-items-center rounded-[30%] bg-pop/30 text-foreground">
            <HandHeart className="size-5" aria-hidden />
          </span>
          <p className="font-medium">No donations yet</p>
          <p className="text-sm text-muted-foreground">Share the link. Donations show here as they land.</p>
        </div>
      ) : (
        <div ref={scrollRef} className="max-h-[32rem] overflow-y-auto overscroll-contain border-t">
          <ul aria-busy={loading} aria-label="Donors" className="relative" style={{ height: virtualizer.getTotalSize() }}>
            {rows.map((row) => {
              const c = items[row.index]
              return (
                <li
                  key={row.key}
                  data-index={row.index}
                  ref={virtualizer.measureElement}
                  className="absolute top-0 left-0 w-full border-b last:border-b-0"
                  style={{ transform: `translateY(${row.start}px)` }}
                >
                  {c ? (
                    <DonorRow checkout={c} onOpen={() => open(c)} />
                  ) : (
                    <div className="grid place-items-center py-4">
                      {error ? (
                        <button type="button" onClick={() => void loadMore()} className="text-sm text-muted-foreground underline underline-offset-4">
                          Couldn&apos;t load more. Try again
                        </button>
                      ) : (
                        <Spinner />
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </section>
  )
}

function DonorRow({ checkout: c, onOpen }: { checkout: LinkCheckout; onOpen: () => void }) {
  const anonymous = !!c.donor?.anonymous
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full gap-3.5 px-6 py-3.5 text-left transition-colors hover:bg-muted/50 focus-visible:bg-muted/60 focus-visible:outline-none sm:px-8"
    >
      <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-[30%] bg-muted text-xs font-semibold text-muted-foreground">
        {initials(c.payer.name)}
      </span>
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="flex items-baseline justify-between gap-3">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate font-medium">{c.payer.name}</span>
            <TestBadge mode={c.mode} className="shrink-0" />
            {anonymous && (
              <Badge variant="muted" className="shrink-0">
                Anonymous on the page
              </Badge>
            )}
            {c.hiddenFromPage && (
              <Badge variant="warning" className="shrink-0">
                <EyeOff aria-hidden />
                Hidden by LinkPay
              </Badge>
            )}
          </span>
          <span className="shrink-0 font-medium figure">{formatNaira(c.paidKobo ?? 0)}</span>
        </span>
        <span className="text-xs text-muted-foreground">{timeAgo(c.paidAt ?? undefined)}</span>
        {c.donor?.message && <span className={cn("mt-0.5 text-sm text-pretty wrap-break-word", c.hiddenFromPage && "text-muted-foreground")}>&ldquo;{c.donor.message}&rdquo;</span>}
      </span>
    </button>
  )
}
