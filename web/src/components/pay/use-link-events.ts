"use client"

import { useEffect, useEffectEvent } from "react"

/** Events that land together (a burst of payments) are handled once. */
const COALESCE_MS = 500

/**
 * The link's live updates (Server-Sent Events from /api/pay/[slug]/events). `onLink`: the link changed
 * (live or test, on or off, its details, a donation hidden); reload what the page shows. `onPaid`: a payment
 * landed; pull in new donations and re-check your own checkout. The browser reconnects by itself; after a
 * reconnect both run once, in case something happened while it was away. `onConnected` says whether the
 * stream is open, so polling can slow down while it is.
 */
export function useLinkEvents(
  slug: string,
  handlers: { onLink: () => void; onPaid: () => void; onConnected?: (connected: boolean) => void },
) {
  const onLink = useEffectEvent(handlers.onLink)
  const onPaid = useEffectEvent(handlers.onPaid)
  const onConnected = useEffectEvent((connected: boolean) => handlers.onConnected?.(connected))

  useEffect(() => {
    if (typeof EventSource === "undefined") return
    const source = new EventSource(`/api/pay/${encodeURIComponent(slug)}/events`)
    const timers = new Map<string, ReturnType<typeof setTimeout>>()
    const soon = (key: string, run: () => void) => {
      if (timers.has(key)) return
      timers.set(
        key,
        setTimeout(() => {
          timers.delete(key)
          run()
        }, COALESCE_MS),
      )
    }
    let readies = 0
    source.addEventListener("ready", () => {
      onConnected(true)
      if (readies++ > 0) {
        soon("link", onLink)
        soon("paid", onPaid)
      }
    })
    source.addEventListener("link", () => soon("link", onLink))
    source.addEventListener("paid", () => soon("paid", onPaid))
    // EventSource retries by itself (the server asks for 5 s); polling covers the gap meanwhile.
    source.addEventListener("error", () => onConnected(false))
    return () => {
      source.close()
      timers.forEach(clearTimeout)
      onConnected(false)
    }
  }, [slug])
}
