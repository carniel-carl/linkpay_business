import type { NextRequest } from "next/server"
import { forwardedFor, payJson, publicApi } from "@/lib/public-pay"

/** Test mode: the pay page simulates the transfer through here (POST /api/public/checkouts/:token/simulate). */
export async function POST(request: NextRequest, ctx: RouteContext<"/api/pay/checkouts/[token]/simulate">) {
  const { token } = await ctx.params
  const json = await request.json().catch(() => ({}))
  const outcome = json && typeof json === "object" && json.outcome === "underpaid" ? "underpaid" : "paid"
  const { status, body } = await publicApi(`/api/public/checkouts/${encodeURIComponent(token)}/simulate`, {
    method: "POST",
    json: { outcome },
    clientIp: forwardedFor(request.headers),
  })
  return payJson(body, status)
}
