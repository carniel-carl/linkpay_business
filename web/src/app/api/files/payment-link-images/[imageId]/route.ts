import type { NextRequest } from "next/server"
import { proxyFile } from "@/lib/file-proxy"

/** A payment link's picture for the dashboard (also pictures not yet saved on a link). */
export async function GET(_request: NextRequest, ctx: RouteContext<"/api/files/payment-link-images/[imageId]">) {
  const { imageId } = await ctx.params
  return proxyFile(`/api/payment-links/images/${encodeURIComponent(imageId)}`, false)
}
