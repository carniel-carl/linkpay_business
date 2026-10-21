import "server-only"
import { apiFile } from "@/lib/api/client"

/** Streams a file from the backend (a KYB document, an invoice PDF), passing the session token along. */
export async function proxyFile(path: string, download: boolean) {
  return relay(await apiFile(path), download, "private, no-store")
}

/**
 * Streams a file anyone with the link may see (a customer's invoice PDF, the business's logo on it).
 * Never sends the visitor's session, so it shows the same thing signed in or not. Only images whose URL
 * changes with them (the logo's `?v=`) should pass a cache lifetime; invoice PDFs change when paid.
 */
export async function proxyPublicFile(path: string, download: boolean, cacheControl = "no-store") {
  let upstream: Response
  try {
    upstream = await fetch(`${process.env.API_URL ?? "http://localhost:4000"}${path}`, { cache: "no-store" })
  } catch {
    return Response.json({ error: "File not available" }, { status: 503 })
  }
  return relay(upstream, download, cacheControl)
}

async function relay(upstream: Response, download: boolean, cacheControl: string) {
  if (!upstream.ok || !upstream.body) {
    const body = await upstream.json().catch(() => ({ error: "File not available" }))
    return Response.json(body, { status: upstream.status })
  }
  const headers = new Headers({
    "Content-Type": upstream.headers.get("content-type") ?? "application/octet-stream",
    "Cache-Control": cacheControl,
    "X-Content-Type-Options": "nosniff",
  })
  const disposition = upstream.headers.get("content-disposition")
  if (disposition) headers.set("Content-Disposition", download ? disposition.replace(/^inline/, "attachment") : disposition)
  const length = upstream.headers.get("content-length")
  if (length) headers.set("Content-Length", length)
  return new Response(upstream.body, { status: 200, headers })
}
