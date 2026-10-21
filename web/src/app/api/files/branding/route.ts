import { proxyFile } from "@/lib/file-proxy"

/** The business's logo, for the branding settings and the invoice preview. */
export async function GET() {
  return proxyFile("/api/branding/logo", false)
}
