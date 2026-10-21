import type { NextRequest } from "next/server"
import { proxyPublicFile } from "@/lib/file-proxy"

/** A picture on a payment-link page. Its URL carries ?v=, so a replaced picture gets a new address. */
export async function GET(request: NextRequest, ctx: RouteContext<"/pay/[slug]/images/[imageId]">) {
  const { slug, imageId } = await ctx.params
  const v = request.nextUrl.searchParams.get("v")
  return proxyPublicFile(
    `/api/public/pay/${encodeURIComponent(slug)}/images/${encodeURIComponent(imageId)}${v ? `?v=${encodeURIComponent(v)}` : ""}`,
    false,
    v ? "public, max-age=604800, immutable" : "no-store",
  )
}
