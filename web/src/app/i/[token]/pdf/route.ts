import type { NextRequest } from "next/server"
import { proxyPublicFile } from "@/lib/file-proxy"

/** The customer's copy of the invoice as a PDF (`?receipt` for the receipt once it's paid). */
export async function GET(request: NextRequest, ctx: RouteContext<"/i/[token]/pdf">) {
  const { token } = await ctx.params
  const kind = request.nextUrl.searchParams.has("receipt") ? "?kind=receipt" : ""
  return proxyPublicFile(`/api/public/invoices/${encodeURIComponent(token)}/pdf${kind}`, request.nextUrl.searchParams.has("download"))
}
