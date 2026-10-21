import "server-only"
import { apiFile } from "@/lib/api/client"

/** Streams a KYB document from the backend, passing the session token along. */
export async function proxyFile(path: string, download: boolean) {
  const upstream = await apiFile(path)
  if (!upstream.ok || !upstream.body) {
    const body = await upstream.json().catch(() => ({ error: "File not available" }))
    return Response.json(body, { status: upstream.status })
  }
  const headers = new Headers({
    "Content-Type": upstream.headers.get("content-type") ?? "application/octet-stream",
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  })
  const disposition = upstream.headers.get("content-disposition")
  if (disposition) headers.set("Content-Disposition", download ? disposition.replace(/^inline/, "attachment") : disposition)
  const length = upstream.headers.get("content-length")
  if (length) headers.set("Content-Length", length)
  return new Response(upstream.body, { status: 200, headers })
}
