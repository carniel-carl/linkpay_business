import type { NextRequest } from "next/server"
import { clientIp } from "@/lib/client-ip"
import { cspLogLine, cspViolations } from "@/lib/csp-report"

// Content-Security-Policy violation reports (src/proxy.ts names this route in report-uri and report-to). Anyone
// can post here, so a body is capped, each request reads at most a few reports, and the route limits itself in
// memory. Each report becomes one line in the server log, built from its own fields only (lib/csp-report.ts).

const MAX_BODY_BYTES = 16 * 1024
const MAX_REPORTS = 10
const WINDOW_MS = 60_000
/** Reports a minute from one address. Without CLIENT_IP_HEADER every visitor counts as one address. */
const PER_ADDRESS = 30
/** Reports a minute in all, whatever their addresses. */
const OVERALL = 300
/** Addresses remembered in a window; past this, unknown addresses wait for the next window. */
const MAX_ADDRESSES = 5_000

const TYPES = ["application/csp-report", "application/reports+json"] as const
type ReportType = (typeof TYPES)[number]

// One fixed window for this server process: counts per address and in all, and what was dropped.
let windowStart = 0
let total = 0
let dropped = 0
const perAddress = new Map<string, number>()

/** Takes `count` reports from the address's allowance. The window rolls over (and owns up to drops) once a minute. */
function allow(address: string, count: number) {
  const now = Date.now()
  if (now - windowStart >= WINDOW_MS) {
    if (dropped) console.warn(`CSP reports: dropped ${dropped} over the limit in the last minute.`)
    windowStart = now
    total = 0
    dropped = 0
    perAddress.clear()
  }
  const used = perAddress.get(address) ?? 0
  if (used + count > PER_ADDRESS || total + count > OVERALL || (!used && perAddress.size >= MAX_ADDRESSES)) {
    dropped += count
    return false
  }
  perAddress.set(address, used + count)
  total += count
  return true
}

/** The body as text, or null once it passes the cap (the rest isn't read). */
async function readCapped(request: NextRequest) {
  const reader = request.body?.getReader()
  if (!reader) return ""
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString("utf8")
}

const empty = (status: number) => new Response(null, { status, headers: { "Cache-Control": "no-store" } })

export async function POST(request: NextRequest) {
  const type = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase()
  if (!TYPES.includes(type as ReportType)) return empty(415)
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return empty(413)

  const raw = await readCapped(request)
  if (raw === null) return empty(413)
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return empty(400)
  }

  const violations = cspViolations(type as ReportType, body, MAX_REPORTS)
  if (!violations.length) return empty(204)
  if (!allow(clientIp(request.headers) ?? "unknown", violations.length)) return empty(429)
  for (const v of violations) console.warn(cspLogLine(v))
  return empty(204)
}
