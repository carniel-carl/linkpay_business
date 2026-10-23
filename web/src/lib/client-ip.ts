// The visitor's IP address, which this server passes to the API (X-Forwarded-For) so its rate limits count each
// visitor rather than this server. Browsers can send any header themselves, so only one that the platform in
// front of this server sets, replacing whatever the browser sent, is believed. CLIENT_IP_HEADER names it:
// "x-real-ip" or "x-forwarded-for" on Vercel, "cf-connecting-ip" behind Cloudflare, or the header your own
// proxy sets (nginx: `proxy_set_header X-Real-IP $remote_addr`). Unset, nothing is passed on.
const HEADER = process.env.CLIENT_IP_HEADER?.trim().toLowerCase()

const IP = /^[0-9a-f.:]{2,45}$/i

let warned = false

export function clientIp(headers: Headers): string | undefined {
  if (!HEADER) {
    if (process.env.NODE_ENV === "production" && !warned) {
      warned = true
      console.warn("CLIENT_IP_HEADER isn't set: the API sees every visitor as this server, so they share its rate limits.")
    }
    return undefined
  }
  // A proxy that appends to X-Forwarded-For puts the address it saw last; anything before it came from the browser.
  const ip = headers.get(HEADER)?.split(",").at(-1)?.trim()
  return ip && IP.test(ip) ? ip : undefined
}
