"use client"

import { useEffect, useRef, useState } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { Bell, BellOff, CheckCheck } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import type { AppNotification } from "@/lib/api/types"
import { timeAgo } from "@/lib/format"
import { cn } from "@/lib/utils"
import { TONE_CLASSES, metaFor } from "./notification-meta"
import { useNotifications } from "./notifications-provider"

/** The header bell: unread count, and the list in a popover. */
export function NotificationBell() {
  const { unread, status, list, load, loadMore, markAllRead, open, showBusiness, opening } = useNotifications()
  const [isOpen, setOpen] = useState(false)

  // A fresh first page each time it opens; live events keep it current while open.
  useEffect(() => {
    if (isOpen) void load()
  }, [isOpen, load])

  const label = unread ? `Notifications, ${unread} unread` : "Notifications"

  return (
    <Popover open={isOpen} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={label}
          className="relative text-brand-surface-foreground hover:bg-brand-surface-foreground/10 hover:text-brand-surface-foreground"
        >
          <Bell aria-hidden className="size-[1.15rem]" />
          {unread > 0 && (
            <span
              aria-hidden
              className="absolute top-1 right-0.5 grid h-4 min-w-4 place-items-center rounded-md bg-pop px-1 text-[10px] leading-none font-semibold text-pop-foreground figure"
            >
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-[min(24rem,calc(100vw-2rem))] gap-0 rounded-2xl p-0">
        <div className="flex items-center gap-3 border-b px-4 py-3">
          <h2 className="flex-1 font-display text-base font-semibold tracking-tight">Notifications</h2>
          <Button variant="ghost" size="sm" onClick={markAllRead} disabled={unread === 0} className="-mr-2 text-muted-foreground">
            <CheckCheck aria-hidden />
            Mark all read
          </Button>
        </div>

        {status === "reconnecting" && (
          <p className="border-b bg-muted/50 px-4 py-2 text-xs text-muted-foreground" role="status">
            Live updates paused. Reconnecting.
          </p>
        )}

        {list.state === "loading" || list.state === "idle" ? (
          <ListSkeleton />
        ) : list.state === "error" ? (
          <div className="grid gap-3 px-4 py-8 text-center text-sm">
            <p className="text-muted-foreground">{list.message}</p>
            <Button variant="outline" size="sm" className="justify-self-center" onClick={load}>
              Try again
            </Button>
          </div>
        ) : list.items.length === 0 ? (
          <div className="grid justify-items-center gap-2 px-6 py-10 text-center">
            <span className="mb-1 grid size-11 place-items-center rounded-[30%] bg-pop-subtle text-primary">
              <BellOff aria-hidden className="size-5" />
            </span>
            <p className="font-display text-base font-semibold tracking-tight">Nothing yet</p>
            <p className="text-sm text-muted-foreground">Payments, transfers and invoice updates will show up here.</p>
          </div>
        ) : (
          <VirtualNotificationList
            items={list.items}
            hasMore={!!list.nextBefore}
            loadingMore={list.loadingMore}
            loadMore={loadMore}
            showBusiness={showBusiness}
            busy={opening}
            onOpen={(n) => {
              open(n)
              if (n.link) setOpen(false)
            }}
          />
        )}
      </PopoverContent>
    </Popover>
  )
}

// A row is about this tall before it's measured (title, two lines of body, the time).
const ROW_ESTIMATE = 92
// Start fetching the next page this many rows before the end.
const PREFETCH_ROWS = 5

/**
 * Only the rows in view (plus a few either side) are in the DOM, however far back the user scrolls.
 * Heights are measured as rows render, since bodies wrap to one or two lines. Older pages load as the
 * end comes into view.
 */
function VirtualNotificationList({
  items,
  hasMore,
  loadingMore,
  loadMore,
  showBusiness,
  busy,
  onOpen,
}: {
  items: AppNotification[]
  hasMore: boolean
  loadingMore: boolean
  loadMore: () => void
  showBusiness: boolean
  busy: boolean
  onOpen: (n: AppNotification) => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  // One extra row at the end holds the "loading older" spinner.
  const count = items.length + (hasMore ? 1 : 0)
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual returns fresh functions each render by design.
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_ESTIMATE,
    getItemKey: (index) => items[index]?._id ?? "more",
    overscan: 6,
  })
  const rows = virtualizer.getVirtualItems()
  const lastIndex = rows.at(-1)?.index ?? -1

  useEffect(() => {
    if (hasMore && !loadingMore && lastIndex >= items.length - PREFETCH_ROWS) loadMore()
  }, [hasMore, loadingMore, lastIndex, items.length, loadMore])

  return (
    <div ref={scrollRef} className="max-h-[min(28rem,65vh)] overflow-y-auto overscroll-contain">
      <ul aria-busy={busy} className="relative" style={{ height: virtualizer.getTotalSize() }}>
        {rows.map((row) => {
          const n = items[row.index]
          return (
            <li
              key={row.key}
              data-index={row.index}
              ref={virtualizer.measureElement}
              className="absolute top-0 left-0 w-full border-b last:border-b-0"
              style={{ transform: `translateY(${row.start}px)` }}
            >
              {n ? (
                <NotificationRow n={n} showBusiness={showBusiness} onOpen={() => onOpen(n)} />
              ) : (
                <div className="flex justify-center py-4 text-muted-foreground" role="status">
                  <Spinner />
                  <span className="sr-only">Loading older notifications</span>
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function NotificationRow({ n, showBusiness, onOpen }: { n: AppNotification; showBusiness: boolean; onOpen: () => void }) {
  const { icon: Icon, tone } = metaFor(n.type)
  const unread = !n.readAt
  const meta = [showBusiness && n.business?.name, timeAgo(n.createdAt)].filter(Boolean).join(" · ")
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "flex w-full gap-3 px-4 py-3 text-left transition-colors duration-150 outline-none hover:bg-muted/60 focus-visible:bg-muted/60",
        unread && "bg-brand-subtle/40",
      )}
    >
      <span className={cn("mt-0.5 grid size-8 shrink-0 place-items-center rounded-[30%]", TONE_CLASSES[tone])}>
        <Icon aria-hidden className="size-4" />
      </span>
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className={cn("text-sm", unread ? "font-semibold" : "font-medium")}>{n.title}</span>
        <span className="line-clamp-2 text-[13px] leading-snug text-muted-foreground">{n.body}</span>
        <span className="text-xs text-muted-foreground">
          <time dateTime={n.createdAt}>{meta}</time>
        </span>
      </span>
      {unread && (
        <span className="mt-1.5 size-2 shrink-0 rounded-full bg-primary">
          <span className="sr-only">Unread</span>
        </span>
      )}
    </button>
  )
}

function ListSkeleton() {
  return (
    <div className="grid gap-4 px-4 py-4" aria-label="Loading notifications">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex gap-3">
          <Skeleton className="size-8 rounded-[30%]" />
          <div className="grid flex-1 gap-1.5">
            <Skeleton className="h-3.5 w-2/5" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-1/4" />
          </div>
        </div>
      ))}
    </div>
  )
}
