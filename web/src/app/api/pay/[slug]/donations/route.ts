import type { NextRequest } from "next/server"
import { forwardedFor, payJson, publicApi } from "@/lib/public-pay"

/** A fundraiser's donor list and progress (GET /api/public/pay/:slug/donations), for the page's list and live updates. */
export async function GET(request: NextRequest, ctx: RouteContext<"/api/pay/[slug]/donations">) {
  const { slug } = await ctx.params
  const query = new URLSearchParams()
  for (const key of ["sort", "before", "take"]) {
    const value = request.nextUrl.searchParams.get(key)
    if (value) query.set(key, value)
  }
  const { status, body } = await publicApi(`/api/public/pay/${encodeURIComponent(slug)}/donations?${query}`, {
    clientIp: forwardedFor(request.headers),
  })
  return payJson(body, status)
}
