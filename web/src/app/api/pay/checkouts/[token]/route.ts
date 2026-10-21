import type { NextRequest } from "next/server"
import { forwardedFor, payJson, publicApi } from "@/lib/public-pay"

/** The pay page polls this until the transfer is matched (GET /api/public/checkouts/:token). */
export async function GET(request: NextRequest, ctx: RouteContext<"/api/pay/checkouts/[token]">) {
  const { token } = await ctx.params
  const { status, body } = await publicApi(`/api/public/checkouts/${encodeURIComponent(token)}`, { clientIp: forwardedFor(request.headers) })
  return payJson(body, status)
}
