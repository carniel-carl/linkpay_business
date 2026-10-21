import type { NextRequest } from "next/server"
import { forwardedFor, payJson, publicApi } from "@/lib/public-pay"

/** The pay page starts a checkout through here (POST /api/public/pay/:slug/checkouts). */
export async function POST(request: NextRequest, ctx: RouteContext<"/api/pay/[slug]/checkouts">) {
  const { slug } = await ctx.params
  const json = await request.json().catch(() => null)
  if (!json || typeof json !== "object") return payJson({ error: "Send the form again.", code: "BAD_REQUEST" }, 400)
  const { status, body } = await publicApi(`/api/public/pay/${encodeURIComponent(slug)}/checkouts`, {
    method: "POST",
    json,
    clientIp: forwardedFor(request.headers),
  })
  return payJson(body, status)
}
