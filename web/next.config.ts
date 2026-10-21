import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  async headers() {
    return [
      // The payment-link script on businesses' websites: short cache so fixes reach them quickly.
      { source: "/embed.js", headers: [{ key: "Cache-Control", value: "public, max-age=300, must-revalidate" }] },
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
