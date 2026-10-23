import type { NextConfig } from "next"

// Sent with every response. The Content-Security-Policy is mostly src/proxy.ts's: pages need a fresh script nonce
// on every request, so the proxy sends the whole policy, frame-ancestors included, in place of the one below.
// That one is what's left where the proxy sends none: API routes, static files, and pages while CSP_REPORT_ONLY=1
// has the proxy's policy only report.
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
