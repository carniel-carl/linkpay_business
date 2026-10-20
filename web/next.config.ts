import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // Documents are capped at 5 MB by the backend; leave room for multipart overhead.
      bodySizeLimit: "6mb",
    },
  },
}

export default nextConfig
