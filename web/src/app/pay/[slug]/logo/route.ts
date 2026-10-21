import type { NextRequest } from "next/server"
import { proxyPublicFile } from "@/lib/file-proxy"

/** The business's logo on its payment-link page and in the payer's receipt email. */
export async function GET(_request: NextRequest, ctx: RouteContext<"/pay/[slug]/logo">) {
  const { slug } = await ctx.params
  return proxyPublicFile(`/api/public/pay/${encodeURIComponent(slug)}/logo`, false, "public, max-age=86400")
}
