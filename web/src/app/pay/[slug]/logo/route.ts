import type { NextRequest } from "next/server"
import { proxyPublicFile } from "@/lib/file-proxy"

// A browser keeps a logo a day (a new upload gets a new ?v=). A CDN keeps it only 5 minutes and then asks again, so
// a link LinkPay takes down, or a suspended business, stops showing it within minutes. The same as the API's
// PUBLIC_LOGO_CACHE (backend/src/controllers/branding.ts).
const LOGO_CACHE = "public, max-age=86400, s-maxage=300"

/** The business's logo on its payment-link page and in the payer's receipt email. */
export async function GET(_request: NextRequest, ctx: RouteContext<"/pay/[slug]/logo">) {
  const { slug } = await ctx.params
  const res = await proxyPublicFile(`/api/public/pay/${encodeURIComponent(slug)}/logo`, false, LOGO_CACHE)
  // A refusal (taken down, no logo, unavailable) is never kept, so a restored link's logo comes back at once.
  if (!res.ok) res.headers.set("Cache-Control", "no-store")
  return res
}
