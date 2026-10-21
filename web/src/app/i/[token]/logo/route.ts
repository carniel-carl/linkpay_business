import type { NextRequest } from "next/server"
import { proxyPublicFile } from "@/lib/file-proxy"

/** The business's logo on its public invoice page and in its invoice emails. */
export async function GET(_request: NextRequest, ctx: RouteContext<"/i/[token]/logo">) {
  const { token } = await ctx.params
  return proxyPublicFile(`/api/public/invoices/${encodeURIComponent(token)}/logo`, false, "public, max-age=86400")
}
