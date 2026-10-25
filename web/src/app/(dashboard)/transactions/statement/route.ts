import type { NextRequest } from "next/server"
import { proxyFile } from "@/lib/file-proxy"

/**
 * A branch account's statement as a download: `?branch=&from=YYYY-MM-DD&to=YYYY-MM-DD&format=pdf|csv`, streamed from
 * GET /api/transactions/statement with the session (docs/briefs/statements.md). Only those four values go on to the
 * API, which checks them; its errors come back as its JSON for the dialog to word.
 */
export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams
  const params = new URLSearchParams({
    branch: q.get("branch") ?? "",
    from: q.get("from") ?? "",
    to: q.get("to") ?? "",
    format: q.get("format") === "csv" ? "csv" : "pdf",
  })
  return proxyFile(`/api/transactions/statement?${params}`, true)
}
