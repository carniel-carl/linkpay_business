import type { NextRequest } from "next/server"
import { apiStream } from "@/lib/api/client"
import { getSessionToken } from "@/lib/session"

/**
 * The staff member's live notifications. The browser can't send the httpOnly session cookie to the
 * backend itself, so this passes the backend's Server-Sent Events stream through, token attached.
 */
export async function GET(request: NextRequest) {
  if (!(await getSessionToken())) return Response.json({ error: "Sign in to continue." }, { status: 401 })

  let upstream: Response
  try {
    upstream = await apiStream("/api/admin/notifications/stream", {
      lastEventId: request.headers.get("last-event-id"),
      signal: request.signal,
    })
  } catch {
    return Response.json({ error: "We can't reach the LinkPay API right now." }, { status: 503 })
  }
  if (!upstream.ok || !upstream.body) {
    const body = await upstream.json().catch(() => ({ error: "Notifications aren't available." }))
    return Response.json(body, { status: upstream.status })
  }

  return new Response(upstream.body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      // no-transform keeps Next's compression from buffering the stream.
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  })
}
