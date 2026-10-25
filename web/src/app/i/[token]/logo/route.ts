import type { NextRequest } from "next/server"
import { proxyPublicFile } from "@/lib/file-proxy"

// A browser keeps a logo a day (a new upload gets a new ?v=). A CDN keeps it only 5 minutes and then asks again, so
// a suspended business's logo stops showing within minutes. The same as the API's PUBLIC_LOGO_CACHE
// (backend/src/controllers/branding.ts).
const LOGO_CACHE = "public, max-age=86400, s-maxage=300"

/** The business's logo on its public invoice page and in its invoice emails. */
export async function GET(_request: NextRequest, ctx: RouteContext<"/i/[token]/logo">) {
  const { token } = await ctx.params
  const res = await proxyPublicFile(`/api/public/invoices/${encodeURIComponent(token)}/logo`, false, LOGO_CACHE)
  // A refusal (no such invoice, no logo, unavailable) is never kept, so a logo comes back as soon as it's allowed.
  if (!res.ok) res.headers.set("Cache-Control", "no-store")
  return res
}
