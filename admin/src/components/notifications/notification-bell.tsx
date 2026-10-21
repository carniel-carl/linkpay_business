"use client"

import { useCallback, useEffect, useRef, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import {
  Bell,
  BellOff,
  CheckCheck,
  ClipboardCheck,
  TriangleAlert,
  UserCog,
  UserPlus,
  type LucideIcon,
} from "lucide-react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { toast } from "sonner"
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from "@/app/(console)/notifications/actions"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Spinner } from "@/components/ui/spinner"
import type { AppNotification } from "@/lib/api/types"
import { timeAgo } from "@/lib/format"
import { cn } from "@/lib/utils"

const ICONS: Record<string, LucideIcon> = {
  "kyb.submitted": ClipboardCheck,
  "account.setup_failed": TriangleAlert,
  "staff.invite_accepted": UserPlus,
  "staff.role_changed": UserCog,
}

// After the stream closes for good (e.g. the server refused it), try again this long after.
const RETRY_MS = 30_000

type ListState = { items: AppNotification[]; nextBefore: string | null; loaded: boolean }

/**
 * The header bell: unread badge, a list of the staff member's notifications, and live updates over the
 * stream at /api/notifications/stream (a pass-through to the backend's Server-Sent Events).
 */
export function NotificationBell({ initialUnread }: { initialUnread: number }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [unread, setUnread] = useState(initialUnread)
  const [list, setList] = useState<ListState>({ items: [], nextBefore: null, loaded: false })
  const [loading, startLoading] = useTransition()
  const [loadError, setLoadError] = useState<string | null>(null)

  const loadPage = useCallback((before?: string) => {
    startLoading(async () => {
      const result = await listNotifications(before)
      if (!result.ok) {
        setLoadError(result.error)
        return
      }
      setLoadError(null)
      setList((prev) => {
        const items = before ? [...prev.items, ...result.data.items] : result.data.items
        return { items: dedupe(items), nextBefore: result.data.nextBefore, loaded: true }
      })
    })
  }, [])

  const nextBefore = list.nextBefore
  const loadMore = useCallback(() => {
    if (nextBefore) loadPage(nextBefore)
  }, [nextBefore, loadPage])

  useNotificationStream({
    onReady: setUnread,
    onNotification: (n, live) => {
      setUnread((u) => u + 1)
      // Before the list is first opened there's nothing to add to; it loads fresh then.
      setList((prev) => (prev.loaded ? { ...prev, items: dedupe([n, ...prev.items]) } : prev))
      if (!live) return
      toast(n.title, {
        description: n.body,
        action: n.link ? { label: "View", onClick: () => router.push(n.link!) } : undefined,
      })
      // Counts in the sidebar, or the staff member's own permissions, may have changed.
      router.refresh()
    },
    onRead: ({ ids, all }) => {
      if (all) {
        setUnread(0)
        setList((prev) => ({ ...prev, items: prev.items.map(markRead) }))
      } else if (ids?.length) {
        setUnread((u) => Math.max(0, u - ids.length))
        setList((prev) => ({ ...prev, items: prev.items.map((n) => (ids.includes(n._id) ? markRead(n) : n)) }))
      }
    },
  })

  function onOpenChange(next: boolean) {
    setOpen(next)
    if (next && !list.loaded) loadPage()
  }

  // The stream's `read` event updates the badge in every open tab, this one included, so these only
  // update the list straight away.
  async function openNotification(n: AppNotification) {
    setOpen(false)
    if (!n.readAt) {
      setList((prev) => ({ ...prev, items: prev.items.map((item) => (item._id === n._id ? markRead(item) : item)) }))
      void markNotificationRead(n._id)
    }
    if (n.link) router.push(n.link)
  }

  const [markingAll, startMarkingAll] = useTransition()
  function markAll() {
    startMarkingAll(async () => {
      const result = await markAllNotificationsRead()
      if (!result.ok) toast.error(result.error)
      else setList((prev) => ({ ...prev, items: prev.items.map(markRead) }))
    })
  }

  const label = unread ? `Notifications, ${unread} unread` : "Notifications"

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative text-brand-surface-muted hover:bg-brand-surface-foreground/10 hover:text-brand-surface-foreground"
          aria-label={label}
        >
          <Bell aria-hidden />
          {unread > 0 && (
            <span
              aria-hidden
              className="figure absolute -top-0.5 -right-0.5 grid h-4.5 min-w-4.5 place-items-center rounded-full bg-pop px-1 text-[10px] leading-none font-semibold text-pop-foreground"
            >
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(24rem,calc(100vw-2rem))] gap-0 overflow-hidden p-0">
        <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
          <h2 className="font-display text-base font-semibold tracking-[-0.01em]">Notifications</h2>
          <Button
            variant="ghost"
            size="sm"
            className="-mr-2 h-8"
            onClick={markAll}
            disabled={markingAll || unread === 0}
          >
            {markingAll ? <Spinner /> : <CheckCheck data-icon="inline-start" aria-hidden />}
            Mark all read
          </Button>
        </div>

        {!list.loaded ? (
          loadError ? (
            <ListMessage>
              {loadError} <RetryButton onClick={() => loadPage()} />
            </ListMessage>
          ) : (
            <div className="grid place-items-center py-10" role="status">
              <Spinner />
              <span className="sr-only">Loading notifications</span>
            </div>
          )
        ) : list.items.length === 0 ? (
          <div className="grid justify-items-center gap-2 px-6 py-10 text-center">
            <BellOff className="size-5 text-muted-foreground" aria-hidden />
            <p className="text-sm font-medium">You&apos;re all caught up</p>
            <p className="text-xs text-muted-foreground">
              New businesses to review, failed account setups and staff changes show here.
            </p>
          </div>
        ) : (
          <>
            <VirtualNotificationList
              items={list.items}
              // After a failed page, stop loading on scroll until the staff member asks again.
              hasMore={!!list.nextBefore && !loadError}
              loadingMore={loading}
              loadMore={loadMore}
              onOpen={openNotification}
            />
            {loadError && (
              <ListMessage>
                {loadError} <RetryButton onClick={loadMore} />
              </ListMessage>
            )}
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}

// Rows are about this tall before they're measured (the body wraps to one or two lines).
const ROW_ESTIMATE = 76
// Start fetching the next page this many rows before the end.
const PREFETCH_ROWS = 5

/**
 * Only the rows in view (plus a few either side) are in the DOM, however far back the list goes. Heights
 * are measured as rows render. Older pages load as the end comes into view.
 */
function VirtualNotificationList({
  items,
  hasMore,
  loadingMore,
  loadMore,
  onOpen,
}: {
  items: AppNotification[]
  hasMore: boolean
  loadingMore: boolean
  loadMore: () => void
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
    <div ref={scrollRef} className="max-h-[min(28rem,70dvh)] overflow-y-auto overscroll-contain">
      <ul aria-busy={loadingMore} className="relative" style={{ height: virtualizer.getTotalSize() }}>
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
                <NotificationRow notification={n} onOpen={onOpen} />
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

function RetryButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="font-medium text-primary underline-offset-4 hover:underline" onClick={onClick}>
      Try again
    </button>
  )
}

function NotificationRow({
  notification: n,
  onOpen,
}: {
  notification: AppNotification
  onOpen: (n: AppNotification) => void
}) {
  const Icon = ICONS[n.type] ?? Bell
  const unread = !n.readAt
  return (
    <button
      type="button"
      onClick={() => onOpen(n)}
      className={cn(
        "flex w-full gap-3 px-4 py-3 text-left transition-colors duration-150 hover:bg-muted/60",
        "focus-visible:bg-muted/60 focus-visible:outline-none",
        unread && "bg-brand-subtle/40",
      )}
    >
      <span
        className={cn(
          "mt-0.5 grid size-8 shrink-0 place-items-center rounded-[30%]",
          n.type === "account.setup_failed" ? "bg-destructive-subtle text-destructive" : "bg-brand-subtle text-primary",
        )}
      >
        <Icon className="size-4" aria-hidden />
      </span>
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="flex items-baseline gap-2">
          <span className={cn("min-w-0 flex-1 truncate text-sm", unread ? "font-semibold" : "font-medium")}>
            {n.title}
          </span>
          <span className="figure shrink-0 text-xs text-muted-foreground">{timeAgo(n.createdAt)}</span>
        </span>
        <span className="line-clamp-2 text-sm text-muted-foreground">{n.body}</span>
      </span>
      {unread && (
        <span className="mt-1.5 size-2 shrink-0 rounded-full bg-primary">
          <span className="sr-only">Unread</span>
        </span>
      )}
    </button>
  )
}

function ListMessage({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-6 text-center text-sm text-muted-foreground">{children}</p>
}

const markRead = (n: AppNotification): AppNotification => (n.readAt ? n : { ...n, readAt: new Date().toISOString() })

function dedupe(items: AppNotification[]) {
  const seen = new Set<string>()
  return items.filter((n) => (seen.has(n._id) ? false : (seen.add(n._id), true)))
}

type StreamHandlers = {
  /** The unread count once connected. */
  onReady: (unread: number) => void
  /** `live` is false for notifications replayed after a reconnect (missed while away). */
  onNotification: (n: AppNotification, live: boolean) => void
  onRead: (e: { ids?: string[]; all?: boolean }) => void
}

/**
 * Keeps one EventSource open while the console is. The browser reconnects by itself after network
 * errors (sending Last-Event-ID, so missed notifications are replayed); when the server refuses the
 * stream it stops, and this tries again after RETRY_MS. An `end` event means the session is over.
 */
function useNotificationStream(handlers: StreamHandlers) {
  const router = useRouter()
  // The latest handlers, so the connection isn't torn down when they change.
  const ref = useRef(handlers)
  useEffect(() => {
    ref.current = handlers
  })

  useEffect(() => {
    let source: EventSource | null = null
    let retry: ReturnType<typeof setTimeout> | undefined
    let stopped = false

    const connect = () => {
      // Replays come before `ready` on each connection; only what arrives after it is new.
      let live = false
      source = new EventSource("/api/notifications/stream")
      source.addEventListener("ready", (e) => {
        live = true
        ref.current.onReady(parse<{ unread: number }>(e)?.unread ?? 0)
      })
      source.addEventListener("notification", (e) => {
        const n = parse<AppNotification>(e)
        if (n) ref.current.onNotification(n, live)
      })
      source.addEventListener("read", (e) => {
        const data = parse<{ ids?: string[]; all?: boolean }>(e)
        if (data) ref.current.onRead(data)
      })
      source.addEventListener("end", () => {
        // The token expired or the session was ended elsewhere; the sign-out route explains it.
        stop()
        router.replace("/auth/sign-out?expired=1")
      })
      source.onerror = () => {
        if (source?.readyState === EventSource.CLOSED && !stopped) {
          source = null
          retry = setTimeout(connect, RETRY_MS)
        }
      }
    }

    const stop = () => {
      stopped = true
      clearTimeout(retry)
      source?.close()
    }

    connect()
    return stop
  }, [router])
}

function parse<T>(e: Event): T | null {
  try {
    return JSON.parse((e as MessageEvent<string>).data) as T
  } catch {
    return null
  }
}
