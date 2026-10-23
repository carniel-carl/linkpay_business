// Content-Security-Policy violation reports: where src/proxy.ts tells browsers to send them, and how
// src/app/api/csp-report/route.ts reads them. No "server-only": the proxy imports the constants.

/** report-uri, for browsers without the Reporting API (Firefox, Safari). Relative, so it's always this site. */
export const CSP_REPORT_PATH = "/api/csp-report"

/** The Reporting-Endpoints name the policy's report-to refers to. */
export const CSP_REPORT_GROUP = "csp"

/** The response header that declares CSP_REPORT_GROUP (Chrome and Edge prefer it to report-uri). */
export const REPORTING_ENDPOINTS = `${CSP_REPORT_GROUP}="${CSP_REPORT_PATH}"`

/** One violation, from either report format, reduced to what the log line needs. */
export type CspViolation = {
  disposition: string
  directive: string
  blocked: string
  page: string
  source: string
}

const MAX_FIELD = 200

/** A report value fit for one log line: a string, no control characters (no forged lines), capped. */
function text(value: unknown) {
  if (typeof value !== "string" && typeof value !== "number") return ""
  return String(value).replace(/\p{Cc}/gu, " ").trim().slice(0, MAX_FIELD)
}

/** Paths whose second segment is a secret: a customer's invoice (/i/<token>) and a team invite (/invite/<token>). */
const TOKEN_PATH = /^\/(i|invite)\/[^/]+/

/**
 * An address fit for a log: no query or fragment (/pay/<slug>?checkout=<token>) and no token in the path.
 * Keywords such as "inline", "eval" or "data" are kept as they are.
 */
function address(value: unknown) {
  const raw = text(value)
  if (!raw) return ""
  try {
    const url = new URL(raw)
    if (url.protocol !== "http:" && url.protocol !== "https:") return url.protocol.replace(/:$/, "")
    return `${url.origin}${url.pathname.replace(TOKEN_PATH, "/$1/…")}`
  } catch {
    return raw.replace(/[?#].*$/, "").replace(TOKEN_PATH, "/$1/…")
  }
}

/** "…/chunk.js:1:2045" when the report says where it happened. */
function location(file: unknown, line: unknown, column: unknown) {
  const where = address(file)
  if (!where) return ""
  const l = text(line)
  const c = text(column)
  return l ? `${where}:${l}${c ? `:${c}` : ""}` : where
}

type Fields = Record<string, unknown>

/** application/csp-report (report-uri): { "csp-report": { "document-uri", "effective-directive", … } }. */
function fromCspReport(body: Fields): CspViolation | null {
  const r = body["csp-report"]
  if (!r || typeof r !== "object") return null
  const f = r as Fields
  return {
    disposition: text(f["disposition"]) || "enforce",
    directive: text(f["effective-directive"]) || text(f["violated-directive"]),
    blocked: address(f["blocked-uri"]),
    page: address(f["document-uri"]),
    source: location(f["source-file"], f["line-number"], f["column-number"]),
  }
}

/** application/reports+json (Reporting API): [{ type: "csp-violation", body: { documentURL, … } }, …]. */
function fromReportingApi(report: unknown): CspViolation | null {
  if (!report || typeof report !== "object") return null
  const r = report as Fields
  if (r.type !== "csp-violation" || !r.body || typeof r.body !== "object") return null
  const f = r.body as Fields
  return {
    disposition: text(f.disposition) || "enforce",
    directive: text(f.effectiveDirective),
    blocked: address(f.blockedURL),
    page: address(f.documentURL ?? r.url),
    source: location(f.sourceFile, f.lineNumber, f.columnNumber),
  }
}

/** The violations in a parsed body of either content type, at most `max` of them. Anything else is ignored. */
export function cspViolations(contentType: "application/csp-report" | "application/reports+json", body: unknown, max: number) {
  const found =
    contentType === "application/csp-report"
      ? [body && typeof body === "object" && !Array.isArray(body) ? fromCspReport(body as Fields) : null]
      : Array.isArray(body)
        ? body.slice(0, max).map(fromReportingApi)
        : []
  return found.filter((v): v is CspViolation => !!v && !!v.directive).slice(0, max)
}

/** The one line a violation gets in the server log. */
export function cspLogLine(v: CspViolation) {
  const mode = v.disposition === "report" ? "report-only" : "blocked"
  return `CSP ${mode}: ${v.directive} ${v.blocked || "(no address)"} on ${v.page || "(unknown page)"}${v.source ? ` at ${v.source}` : ""}`
}
