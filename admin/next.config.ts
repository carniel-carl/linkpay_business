import type { NextConfig } from "next"

// Sent with every response. No Content-Security-Policy beyond frame-ancestors: a strict script policy needs a
// per-request nonce on every page (Next's own inline scripts included), which this app doesn't render yet.
const SECURITY_HEADERS = [
  // Not includeSubDomains: other hosts on the domain aren't ours to commit to HTTPS. Ignored over plain http (dev).
  { key: "Strict-Transport-Security", value: "max-age=31536000" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "same-origin" },
  // The console is never shown in a frame by another site.
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Frame-Options", value: "DENY" },
]

const nextConfig: NextConfig = {
  async headers() {
    return [
      { source: "/:path*", headers: SECURITY_HEADERS },
      // KYB documents: the console previews PDFs in a frame of its own (components/admin/document-viewer.tsx).
      // Later entries win for the same header.
      {
        source: "/api/files/:path*",
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors 'self'" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
        ],
      },
    ]
  },
  experimental: {
    serverActions: {
      // Documents are capped at 5 MB by the backend; leave room for multipart overhead.
      bodySizeLimit: "6mb",
    },
  },
}

export default nextConfig
