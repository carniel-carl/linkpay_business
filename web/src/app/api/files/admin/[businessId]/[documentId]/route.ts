import type { NextRequest } from "next/server"
import { proxyFile } from "@/lib/file-proxy"

export async function GET(request: NextRequest, ctx: RouteContext<"/api/files/admin/[businessId]/[documentId]">) {
  const { businessId, documentId } = await ctx.params
  const download = request.nextUrl.searchParams.has("download")
  return proxyFile(
    `/api/admin/businesses/${encodeURIComponent(businessId)}/documents/${encodeURIComponent(documentId)}/file`,
    download,
  )
}
