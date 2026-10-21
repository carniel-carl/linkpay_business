import type { NextRequest } from "next/server"
import { forwardedFor, payJson, publicApi } from "@/lib/public-pay"

/** "Report this fundraiser" (POST /api/public/pay/:slug/reports): goes to LinkPay staff, never the business. */
export async function POST(request: NextRequest, ctx: RouteContext<"/api/pay/[slug]/reports">) {
  const { slug } = await ctx.params
  const json = await request.json().catch(() => null)
  if (!json || typeof json !== "object") return payJson({ error: "Send the form again.", code: "BAD_REQUEST" }, 400)
  const { status, body } = await publicApi(`/api/public/pay/${encodeURIComponent(slug)}/reports`, {
    method: "POST",
    json,
    clientIp: forwardedFor(request.headers),
  })
  return payJson(body, status)
}
