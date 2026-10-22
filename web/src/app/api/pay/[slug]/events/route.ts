import type { NextRequest } from "next/server"
import { forwardedFor, payJson } from "@/lib/public-pay"

const API_URL = process.env.API_URL ?? "http://localhost:4000"

/**
 * Live updates for a payment link's page (Server-Sent Events), relayed from the backend's
 * GET /api/public/pay/:slug/events: `ready`, then `link` when the link changes and `paid` when a payment lands.
 * Passed through unbuffered; closing the page aborts the upstream request.
 */
export async function GET(request: NextRequest, ctx: RouteContext<"/api/pay/[slug]/events">) {
  const { slug } = await ctx.params
  const clientIp = forwardedFor(request.headers)
  let upstream: Response
  try {
    upstream = await fetch(`${API_URL}/api/public/pay/${encodeURIComponent(slug)}/events`, {
      headers: { Accept: "text/event-stream", ...(clientIp && { "X-Forwarded-For": clientIp }) },
      cache: "no-store",
      signal: request.signal,
    })
  } catch {
    return payJson({ error: "Live updates aren't available right now", code: "API_UNREACHABLE" }, 503)
  }

  if (!upstream.ok || !upstream.body) {
    const body = await upstream.json().catch(() => ({ error: "Live updates aren't available right now" }))
    return payJson(body, upstream.status === 200 ? 502 : upstream.status)
  }

  return new Response(upstream.body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      // no-transform keeps Next's gzip (and other proxies) from buffering the stream.
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Robots-Tag": "noindex",
    },
  })
}
