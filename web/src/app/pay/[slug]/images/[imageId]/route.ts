import type { NextRequest } from "next/server"
import { proxyPublicFile } from "@/lib/file-proxy"

// A browser keeps a picture a week (a replaced picture gets a new address). A CDN keeps it only 5 minutes and then
// asks again, so a link LinkPay takes down stops showing its pictures within minutes. Not `immutable`. The same
// as the API's PUBLIC_LINK_IMAGE_CACHE (backend/src/controllers/publicPaymentLinks.ts).
const PICTURE_CACHE = "public, max-age=604800, s-maxage=300"

/** A picture on a payment-link page. Its URL carries ?v=, so a replaced picture gets a new address. */
export async function GET(request: NextRequest, ctx: RouteContext<"/pay/[slug]/images/[imageId]">) {
  const { slug, imageId } = await ctx.params
  const v = request.nextUrl.searchParams.get("v")
  const res = await proxyPublicFile(
    `/api/public/pay/${encodeURIComponent(slug)}/images/${encodeURIComponent(imageId)}${v ? `?v=${encodeURIComponent(v)}` : ""}`,
    false,
    v ? PICTURE_CACHE : "no-store",
  )
  // A refusal (taken down, gone, unavailable) is never kept, so a restored link's pictures come back at once.
  if (!res.ok) res.headers.set("Cache-Control", "no-store")
  return res
}
