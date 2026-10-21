const nairaWhole = new Intl.NumberFormat("en-NG", {
  style: "currency",
  currency: "NGN",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
})

/**
 * Formats integer kobo as naira: 123456 -> "₦1,234.56". Integer arithmetic only: the naira part
 * goes through Intl for grouping and the symbol, the kobo part is appended as two digits, so no
 * floating-point value ever represents money. Render inside an element with the `figure` utility.
 */
export function formatNaira(kobo: number) {
  const k = Math.trunc(kobo)
  const negative = k < 0
  const abs = Math.abs(k)
  const naira = Math.trunc(abs / 100)
  const rest = String(abs % 100).padStart(2, "0")
  const whole = nairaWhole.format(naira)
  return `${negative ? "-" : ""}${whole}.${rest}`
}

/** •••• 5678 */
export function maskBVN(last4?: string) {
  return last4 ? `•••• ${last4}` : "Not added"
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// Nigeria-only product: times are always Lagos time, which also keeps the server render and the
// browser's hydration identical whatever the machine's time zone.
const TZ = "Africa/Lagos"
const dateFmt = new Intl.DateTimeFormat("en-NG", { day: "numeric", month: "short", year: "numeric", timeZone: TZ })
const dateTimeFmt = new Intl.DateTimeFormat("en-NG", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: TZ,
})
const timeFmt = new Intl.DateTimeFormat("en-NG", { hour: "numeric", minute: "2-digit", timeZone: TZ })
const shortDateFmt = new Intl.DateTimeFormat("en-NG", { day: "numeric", month: "short", timeZone: TZ })

export function formatDate(iso?: string) {
  return iso ? dateFmt.format(new Date(iso)) : ""
}

export function formatDateTime(iso?: string) {
  return iso ? dateTimeFmt.format(new Date(iso)) : ""
}

/** "2:14 pm" in Lagos. */
export function formatTime(iso?: string) {
  return iso ? timeFmt.format(new Date(iso)) : ""
}

/** "26 Sept", for dates in the current year. */
export function formatShortDate(iso?: string) {
  return iso ? shortDateFmt.format(new Date(iso)) : ""
}

/** "3 days ago", "just now". */
export function timeAgo(iso?: string) {
  if (!iso) return ""
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" })
  // [seconds in one unit, unit]; a unit is used until the next one up is reached.
  const units: [number, Intl.RelativeTimeFormatUnit][] = [
    [60, "minute"],
    [3600, "hour"],
    [86400, "day"],
    [604800, "week"],
    [2629800, "month"],
    [31557600, "year"],
  ]
  if (seconds < 45) return "just now"
  for (let i = 0; i < units.length - 1; i++) {
    if (seconds < units[i + 1][0]) return rtf.format(-Math.max(1, Math.round(seconds / units[i][0])), units[i][1])
  }
  return rtf.format(-Math.round(seconds / 31557600), "year")
}

export function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("")
}
