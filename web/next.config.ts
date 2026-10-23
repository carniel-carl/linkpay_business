import type { NextConfig } from "next"

// Sent with every response. The Content-Security-Policy is mostly src/proxy.ts's: pages need a fresh script nonce
// on every request, so the proxy sends the whole policy, frame-ancestors included, in place of the one below.
const SECURITY_HEADERS = [
  // Not includeSubDomains: other hosts on the domain aren't ours to commit to HTTPS. Ignored over plain http (dev).
  { key: "Strict-Transport-Security", value: "max-age=31536000" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Tokens live in some paths and queries (/i/<token>, /pay/<slug>?checkout=<token>): other sites get the origin only.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
]

// Nothing here may be shown in a frame, except the payment-link pages: src/proxy.ts gives every /pay/ path its
// own frame-ancestors (the link's allowed websites). /embed.js is a script, so framing rules don't apply to it.
// This policy is what's left where the proxy sends none: API routes, static files, embed.js, invoice PDFs, and
// pages other than /pay/ while CSP_REPORT_ONLY=1 has the proxy's policy only report.
const NO_FRAMING = [
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Frame-Options", value: "DENY" },
]

const nextConfig: NextConfig = {
  async headers() {
    return [
      { source: "/:path*", headers: SECURITY_HEADERS },
      { source: "/", headers: NO_FRAMING },
      { source: "/:path((?!pay/).*)", headers: NO_FRAMING },
      // The payment-link script on businesses' websites: short cache so fixes reach them quickly.
      { source: "/embed.js", headers: [{ key: "Cache-Control", value: "public, max-age=300, must-revalidate" }] },
    ]
  },
  logging: {
    // `next dev` prints every Server Action call with its arguments, and those include transaction PINs,
    // passwords and emailed codes (docs/briefs/transaction-pin.md: the PIN is never logged).
    serverFunctions: false,
  },
  experimental: {
    serverActions: {
      // Documents are capped at 5 MB by the backend; leave room for multipart overhead.
      bodySizeLimit: "6mb",
    },
  },
}

export default nextConfig
