"use client"

import { createContext, use, useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { selectBusiness } from "@/app/(dashboard)/business-actions"
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  unreadNotificationCount,
} from "@/app/(dashboard)/notification-actions"
import type { AppNotification } from "@/lib/api/types"
import { createSseParser } from "./sse"

const STREAM_URL = "/api/notifications/stream"
// The backend pings every 20 s; this long without a byte means the connection silently died.
const STALE_MS = 50_000
const MAX_BACKOFF_MS = 60_000
// Older notifications replayed on reconnect go into the list without a toast.
const TOAST_WINDOW_MS = 2 * 60_000

export type StreamStatus = "connecting" | "live" | "reconnecting" | "stopped"

type ListState =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; items: AppNotification[]; nextBefore: string | null; loadingMore: boolean }

type NotificationsContext = {
  unread: number
  status: StreamStatus
  list: ListState
  /** Loads the first page (again). The bell calls it when opened. */
  load: () => void
  loadMore: () => void
  markAllRead: () => void
  /** Marks it read, switches to its business if needed, and opens its link. */
  open: (n: AppNotification) => void
  /** Whether to name the business on each notification (the user is in more than one). */
  showBusiness: boolean
  opening: boolean
}

const Context = createContext<NotificationsContext | null>(null)

export function useNotifications() {
  const ctx = use(Context)
  if (!ctx) throw new Error("useNotifications needs NotificationsProvider")
  return ctx
}

/**
 * Holds the signed-in user's notifications for the dashboard: the unread count, the bell's list and
 * one live connection (Server-Sent Events through /api/notifications/stream). New notifications show
 * a toast, and ones about the business on screen refresh the page so balances and lists stay current.
 */
export function NotificationsProvider({
  children,
  initialUnread,
  businessId,
  showBusiness,
}: {
  children: React.ReactNode
  initialUnread: number
  businessId: string
  showBusiness: boolean
}) {
  const router = useRouter()
  const [unread, setUnread] = useState(initialUnread)
  const [status, setStatus] = useState<StreamStatus>("connecting")
  const [list, setList] = useState<ListState>({ state: "idle" })
  const [opening, startOpening] = useTransition()

  // Read in the stream callbacks without reconnecting when they change.
  const businessRef = useRef(businessId)
  const listRef = useRef(list)
  const openRef = useRef<(n: AppNotification) => void>(() => {})
  useEffect(() => {
    businessRef.current = businessId
    listRef.current = list
  })
  // Ids this tab already counted as read, so the stream's echo of our own change isn't counted twice.
  const countedRead = useRef(new Set<string>())

  const load = useCallback(async () => {
    setList((l) => (l.state === "ready" ? l : { state: "loading" }))
    const res = await listNotifications()
    if (!res.ok) return setList({ state: "error", message: res.error })
    setList({ state: "ready", items: res.data.items, nextBefore: res.data.nextBefore, loadingMore: false })
  }, [])

  const loadMore = useCallback(async () => {
    const current = listRef.current
    if (current.state !== "ready" || !current.nextBefore || current.loadingMore) return
    setList({ ...current, loadingMore: true })
    const res = await listNotifications({ before: current.nextBefore })
    setList((l) => {
      if (l.state !== "ready") return l
      if (!res.ok) {
        toast.error(res.error)
        return { ...l, loadingMore: false }
      }
      const seen = new Set(l.items.map((n) => n._id))
      return {
        state: "ready",
        items: [...l.items, ...res.data.items.filter((n) => !seen.has(n._id))],
        nextBefore: res.data.nextBefore,
        loadingMore: false,
      }
    })
  }, [])

  const markReadLocally = useCallback((ids: string[] | "all", business?: string | null) => {
    const now = new Date().toISOString()
    setList((l) =>
      l.state !== "ready"
        ? l
        : {
            ...l,
            items: l.items.map((n) =>
              !n.readAt && (ids === "all" ? !business || n.business?._id === business : ids.includes(n._id))
                ? { ...n, readAt: now }
                : n,
            ),
          },
    )
  }, [])

  const markAllRead = useCallback(async () => {
    const before = unread
    setUnread(0)
    markReadLocally("all")
    const res = await markAllNotificationsRead()
    if (!res.ok) {
      setUnread(before)
      toast.error(res.error)
    }
  }, [unread, markReadLocally])

  const open = useCallback(
    (n: AppNotification) => {
      if (!n.readAt && !countedRead.current.has(n._id)) {
        countedRead.current.add(n._id)
        setUnread((u) => Math.max(0, u - 1))
        markReadLocally([n._id])
        void markNotificationRead(n._id)
      }
      if (!n.link) return
      const link = n.link
      startOpening(async () => {
        // Notifications cover all the user's businesses; the page must show the one it's about.
        if (n.business && n.business._id !== businessRef.current) await selectBusiness(n.business._id)
        router.push(link)
      })
    },
    [markReadLocally, router],
  )
  useEffect(() => {
    openRef.current = open
  })

  // ---- The live connection ----
  useEffect(() => {
    let stopped = false
    let controller: AbortController | null = null
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let staleTimer: ReturnType<typeof setTimeout> | undefined
    let refreshTimer: ReturnType<typeof setTimeout> | undefined
    let refreshWhenVisible = false
    let attempt = 0
    let lastEventId: string | null = null

    const refreshSoon = () => {
      if (document.visibilityState !== "visible") {
        refreshWhenVisible = true
        return
      }
      clearTimeout(refreshTimer)
      // Several events often arrive together (a bulk transfer); refresh once.
      refreshTimer = setTimeout(() => router.refresh(), 800)
    }

    const scheduleReconnect = (delay?: number) => {
      if (stopped) return
      setStatus("reconnecting")
      const wait = delay ?? Math.min(MAX_BACKOFF_MS, 2_000 * 2 ** attempt) + Math.random() * 1_000
      attempt++
      clearTimeout(retryTimer)
      retryTimer = setTimeout(connect, wait)
    }

    function onNotification(n: AppNotification, live: boolean) {
      setList((l) =>
        l.state !== "ready" || l.items.some((x) => x._id === n._id) ? l : { ...l, items: [n, ...l.items] },
      )
      // Before `ready` these are replays; the ready event carries the true count.
      if (!live) return
      if (!n.readAt) setUnread((u) => u + 1)
      const forThisBusiness = !n.business || n.business._id === businessRef.current
      if (forThisBusiness) refreshSoon()
      if (Date.now() - new Date(n.createdAt).getTime() > TOAST_WINDOW_MS) return
      toast(n.title, {
        id: n._id,
        description: !forThisBusiness && n.business?.name ? `${n.business.name}: ${n.body}` : n.body,
        action: n.link ? { label: "View", onClick: () => openRef.current(n) } : undefined,
      })
    }

    function onRead(payload: { ids?: string[]; all?: boolean; business?: string | null }) {
      if (payload.all) {
        markReadLocally("all", payload.business)
        if (!payload.business) return setUnread(0)
        // Only one business's were read (on another device); ask for the exact count.
        void unreadNotificationCount().then((res) => res.ok && setUnread(res.data))
        return
      }
      const fresh = (payload.ids ?? []).filter((id) => !countedRead.current.has(id))
      fresh.forEach((id) => countedRead.current.add(id))
      if (fresh.length) {
        setUnread((u) => Math.max(0, u - fresh.length))
        markReadLocally(fresh)
      }
    }

    async function connect() {
      if (stopped) return
      controller?.abort()
      const ctrl = new AbortController()
      controller = ctrl
      const resetStale = () => {
        clearTimeout(staleTimer)
        staleTimer = setTimeout(() => ctrl.abort(), STALE_MS)
      }
      let live = false
      let ended: string | null = null

      try {
        const url = lastEventId ? `${STREAM_URL}?lastEventId=${encodeURIComponent(lastEventId)}` : STREAM_URL
        const res = await fetch(url, { headers: { Accept: "text/event-stream" }, cache: "no-store", signal: ctrl.signal })
        if (res.status === 401) {
          // Signed out or the session ended: the next page load sends them to sign in.
          stopped = true
          return setStatus("stopped")
        }
        if (res.status === 429) return scheduleReconnect(MAX_BACKOFF_MS) // too many tabs open
        if (!res.ok || !res.body) return scheduleReconnect()

        const push = createSseParser(({ event, data, id }) => {
          let payload: unknown
          try {
            payload = JSON.parse(data)
          } catch {
            return
          }
          if (event === "notification") {
            if (id) lastEventId = id
            onNotification(payload as AppNotification, live)
          } else if (event === "read") {
            onRead(payload as { ids?: string[]; all?: boolean; business?: string | null })
          } else if (event === "ready") {
            live = true
            attempt = 0
            setStatus("live")
            setUnread((payload as { unread: number }).unread)
            // Anything missed past the replay limit shows up when the list is reloaded.
            if (listRef.current.state === "ready") void load()
          } else if (event === "end") {
            ended = (payload as { reason: string }).reason
          }
        })

        resetStale()
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          resetStale()
          push(value)
        }
      } catch {
        // Network drop, or aborted for going quiet. Fall through to reconnect.
      } finally {
        clearTimeout(staleTimer)
      }

      if (stopped || controller !== ctrl) return
      if (ended === "session_ended") {
        stopped = true
        return setStatus("stopped")
      }
      // token_expired: try straight away (a 401 then stops us). Anything else: back off.
      scheduleReconnect(ended === "token_expired" ? 0 : undefined)
    }

    const onVisible = () => {
      if (document.visibilityState !== "visible") return
      if (refreshWhenVisible) {
        refreshWhenVisible = false
        refreshSoon()
      }
      // Coming back to the tab: don't wait out a long backoff.
      if (!stopped && attempt > 0) {
        clearTimeout(retryTimer)
        void connect()
      }
    }
    const onOnline = () => {
      if (!stopped && attempt > 0) {
        clearTimeout(retryTimer)
        void connect()
      }
    }

    void connect()
    document.addEventListener("visibilitychange", onVisible)
    window.addEventListener("online", onOnline)
    return () => {
      stopped = true
      controller?.abort()
      clearTimeout(retryTimer)
      clearTimeout(staleTimer)
      clearTimeout(refreshTimer)
      document.removeEventListener("visibilitychange", onVisible)
      window.removeEventListener("online", onOnline)
    }
  }, [router, load, markReadLocally])

  const value = useMemo(
    () => ({ unread, status, list, load, loadMore, markAllRead, open, showBusiness, opening }),
    [unread, status, list, load, loadMore, markAllRead, open, showBusiness, opening],
  )
  return <Context value={value}>{children}</Context>
}
