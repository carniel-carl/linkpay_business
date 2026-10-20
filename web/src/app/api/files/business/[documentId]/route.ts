import type { NextRequest } from "next/server"
import { proxyFile } from "@/lib/file-proxy"

export async function GET(request: NextRequest, ctx: RouteContext<"/api/files/business/[documentId]">) {
  const { documentId } = await ctx.params
  const download = request.nextUrl.searchParams.has("download")
  return proxyFile(`/api/business/documents/${encodeURIComponent(documentId)}/file`, download)
}
