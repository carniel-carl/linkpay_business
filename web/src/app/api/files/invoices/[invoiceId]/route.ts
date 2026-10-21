import type { NextRequest } from "next/server"
import { proxyFile } from "@/lib/file-proxy"

/** The invoice's PDF (`?receipt` for the receipt, `?download` to save it). */
export async function GET(request: NextRequest, ctx: RouteContext<"/api/files/invoices/[invoiceId]">) {
  const { invoiceId } = await ctx.params
  const { searchParams } = request.nextUrl
  const kind = searchParams.has("receipt") ? "?kind=receipt" : ""
  return proxyFile(`/api/invoices/${encodeURIComponent(invoiceId)}/pdf${kind}`, searchParams.has("download"))
}
