import type { NextRequest } from "next/server"
import { getSessionToken } from "@/lib/session"

const API_URL = process.env.API_URL ?? "http://localhost:4000"
const ID = /^[a-f\d]{24}$/i

/**
 * Live notifications (Server-Sent Events), relayed from the backend so the session token never reaches
 * the browser. The stream is passed through unbuffered; closing the tab aborts the upstream request.
 * `?lastEventId=` (or the Last-Event-ID header) replays what was missed while disconnected.
 */
export async function GET(request: NextRequest) {
  const token = await getSessionToken()
  if (!token) return Response.json({ error: "Sign in again", code: "UNAUTHENTICATED" }, { status: 401 })

  const lastEventId = request.headers.get("last-event-id") ?? request.nextUrl.searchParams.get("lastEventId")
  let upstream: Response
  try {
    upstream = await fetch(`${API_URL}/api/notifications/stream`, {
      headers: {
        Accept: "text/event-stream",
        Authorization: `Bearer ${token}`,
        ...(lastEventId && ID.test(lastEventId) && { "Last-Event-ID": lastEventId }),
      },
      cache: "no-store",
      signal: request.signal,
    })
  } catch {
    return Response.json({ error: "Notifications aren't available right now", code: "API_UNREACHABLE" }, { status: 503 })
  }

  if (!upstream.ok || !upstream.body) {
    const body = await upstream.json().catch(() => ({ error: "Notifications aren't available right now" }))
    return Response.json(body, { status: upstream.status === 200 ? 502 : upstream.status })
  }

  return new Response(upstream.body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      // no-transform keeps Next's gzip (and other proxies) from buffering the stream.
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  })
}
