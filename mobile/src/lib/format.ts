/** "just now", "5 minutes ago", "yesterday", or a Lagos-time date for anything older than a week. */
export function timeAgo(iso?: string) {
  if (!iso) return "";
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return new Intl.DateTimeFormat("en-NG", { day: "numeric", month: "short", year: "numeric", timeZone: "Africa/Lagos" }).format(
    new Date(iso),
  );
}

// ---- Money ----

const nairaWhole = new Intl.NumberFormat("en-NG", { style: "currency", currency: "NGN", minimumFractionDigits: 0, maximumFractionDigits: 0 });

/**
 * Integer kobo as naira, split for display: 418265040 -> { whole: "₦4,182,650", kobo: ".40" }. Integer
 * arithmetic only, as on the web (web/src/lib/format.ts): no floating-point value ever holds money.
 */
export function nairaParts(kobo: number) {
  const k = Math.trunc(kobo);
  const abs = Math.abs(k);
  return { whole: `${k < 0 ? "-" : ""}${nairaWhole.format(Math.trunc(abs / 100))}`, kobo: `.${String(abs % 100).padStart(2, "0")}` };
}

/** "₦1,234.56" */
export function formatNaira(kobo: number) {
  const { whole, kobo: rest } = nairaParts(kobo);
  return whole + rest;
}

/** "₦85,000" when there are no kobo, otherwise "₦85,000.50": for lists, where most payments are whole naira. */
export function formatNairaShort(kobo: number) {
  const { whole, kobo: rest } = nairaParts(kobo);
  return rest === ".00" ? whole : whole + rest;
}

/** NUBAN in readable groups: 9021448715 -> "902 144 8715". Screen readers get the plain digits. */
export function formatAccountNumber(n: string) {
  return /^\d{10}$/.test(n) ? `${n.slice(0, 3)} ${n.slice(3, 6)} ${n.slice(6)}` : n;
}

export function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("");
}

// ---- Dates (always Lagos time) ----

const TZ = "Africa/Lagos";
const timeFmt = new Intl.DateTimeFormat("en-NG", { hour: "numeric", minute: "2-digit", timeZone: TZ });
const dateTimeFmt = new Intl.DateTimeFormat("en-NG", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: TZ });
const dayFmt = new Intl.DateTimeFormat("en-NG", { weekday: "short", day: "numeric", month: "short", timeZone: TZ });
const lagosDay = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });

/** "2:14 pm" */
export const formatTime = (iso: string) => timeFmt.format(new Date(iso));

const dateFmt = new Intl.DateTimeFormat("en-NG", { day: "numeric", month: "short", year: "numeric", timeZone: TZ });

/** "20 Oct 2026" */
export const formatDate = (iso: string) => dateFmt.format(new Date(iso));

/** "20 Oct 2026, 2:14 pm" */
export const formatDateTime = (iso: string) => dateTimeFmt.format(new Date(iso));

/** YYYY-MM-DD of the Lagos calendar day. */
export const lagosDate = (d: Date | string = new Date()) => lagosDay.format(typeof d === "string" ? new Date(d) : d);

/** "Today", "Yesterday" or "Mon, 12 Oct", for section headers. */
export function dayHeading(day: string, now = new Date()) {
  const today = lagosDate(now);
  if (day === today) return "Today";
  if (day === lagosDate(new Date(now.getTime() - 86_400_000))) return "Yesterday";
  return dayFmt.format(new Date(`${day}T12:00:00+01:00`));
}
