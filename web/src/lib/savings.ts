import {
  Building2,
  CalendarDays,
  Car,
  Flag,
  GraduationCap,
  HeartPulse,
  Landmark,
  Laptop,
  type LucideIcon,
  Megaphone,
  Package,
  PiggyBank,
  Plane,
  Receipt,
  ShieldCheck,
  Store,
  TrendingUp,
  Truck,
  Users,
  Wrench,
  Zap,
} from "lucide-react"
import type { Pocket, PocketColor, PocketIcon, PocketMovement } from "@/lib/api/types"
import { formatNaira } from "@/lib/format"

/** Colour keys the API accepts, in the order the picker shows them. Each maps to `--pocket-<key>` tokens. */
export const POCKET_COLORS: PocketColor[] = ["lime", "green", "teal", "blue", "violet", "pink", "orange", "amber", "slate"]

export const COLOR_LABELS: Record<PocketColor, string> = {
  lime: "Lime",
  green: "Green",
  teal: "Teal",
  blue: "Blue",
  violet: "Violet",
  pink: "Pink",
  orange: "Orange",
  amber: "Amber",
  slate: "Slate",
}

/** Inline style that points a pocket's tile and progress bar at its colour tokens. */
export const pocketColorStyle = (color: PocketColor) =>
  ({ "--pc": `var(--pocket-${color})`, "--pc-subtle": `var(--pocket-${color}-subtle)` }) as React.CSSProperties

/** Icons offered in the picker, in order: things businesses save for. Keys match the API's `icon`. */
export const POCKET_ICONS: Record<PocketIcon, { label: string; Icon: LucideIcon }> = {
  savings: { label: "Savings", Icon: PiggyBank },
  tax: { label: "Tax", Icon: Receipt },
  payroll: { label: "Payroll", Icon: Users },
  rent: { label: "Rent", Icon: Building2 },
  shop: { label: "Shop", Icon: Store },
  stock: { label: "Stock", Icon: Package },
  delivery: { label: "Delivery", Icon: Truck },
  power: { label: "Power", Icon: Zap },
  repairs: { label: "Repairs", Icon: Wrench },
  equipment: { label: "Equipment", Icon: Laptop },
  vehicle: { label: "Vehicle", Icon: Car },
  travel: { label: "Travel", Icon: Plane },
  marketing: { label: "Marketing", Icon: Megaphone },
  growth: { label: "Growth", Icon: TrendingUp },
  emergency: { label: "Emergency fund", Icon: ShieldCheck },
  loan: { label: "Loan", Icon: Landmark },
  training: { label: "Training", Icon: GraduationCap },
  health: { label: "Health", Icon: HeartPulse },
  events: { label: "Events", Icon: CalendarDays },
  goal: { label: "Goal", Icon: Flag },
}

export const POCKET_ICON_KEYS = Object.keys(POCKET_ICONS) as PocketIcon[]

export const MAX_POCKETS_PER_BRANCH = 20

/**
 * The page keeps its state in the URL: Pockets (?status=closed&pocket=) or Safelock (?view=safelock&status=released&safelock=).
 * A `safelock` link (the release notification) opens the Safelock view.
 */
export type SavingsQuery = {
  view: "pockets" | "safelock"
  status: "active" | "closed"
  lockStatus: "locked" | "released"
  pocket?: string
  safelock?: string
}

type RawParams = Record<string, string | string[] | undefined>
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)
const ID = /^[a-f\d]{24}$/i

export function parseSavingsQuery(params: RawParams): SavingsQuery {
  const pocket = one(params.pocket)
  const safelock = one(params.safelock)
  const lockId = safelock && ID.test(safelock) ? safelock : undefined
  return {
    view: one(params.view) === "safelock" || lockId ? "safelock" : "pockets",
    status: one(params.status) === "closed" ? "closed" : "active",
    lockStatus: one(params.status) === "released" ? "released" : "locked",
    pocket: pocket && ID.test(pocket) ? pocket : undefined,
    safelock: lockId,
  }
}

/** "50 days left", "1 day left", "Unlocks today". */
export function daysLeftLabel(days: number) {
  if (days <= 0) return "Unlocks today"
  return days === 1 ? "1 day left" : `${days.toLocaleString("en-NG")} days left`
}

/** Adds days to a YYYY-MM-DD calendar day. */
export function addDays(day: string, days: number) {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** Whole days from one YYYY-MM-DD to another. */
export const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)

/** "5% of every payment in" or "₦2,000.00 from every payment in". */
export function describeAutoSave(autoSave: Pocket["autoSave"]) {
  if (!autoSave) return null
  if (autoSave.percentBps !== null) return `${formatPercent(autoSave.percentBps)} of every payment in`
  return `${formatNaira(autoSave.amountKobo)} from every payment in`
}

/** Short tag for cards: "Auto-saving 5%". */
export function autoSaveTag(autoSave: Pocket["autoSave"]) {
  if (!autoSave) return null
  return autoSave.percentBps !== null ? `Auto-saving ${formatPercent(autoSave.percentBps)}` : "Auto-saving"
}

/** 550 -> "5.5%", 1000 -> "10%". */
export const formatPercent = (bps: number) => `${(bps / 100).toLocaleString("en-NG", { maximumFractionDigits: 2 })}%`

/** "12.5" -> 1250 basis points, or null. */
export function parsePercentToBps(input: string): number | null {
  const match = /^(\d{1,3})(?:\.(\d{0,2}))?$/.exec(input.trim().replace(/%$/, ""))
  if (!match) return null
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"))
}

/** "15 Mar 2027" from "2027-03-15", read as a calendar day (no time zone shift). */
export function formatDay(day: string) {
  const [y, m, d] = day.split("-").map(Number)
  return new Intl.DateTimeFormat("en-NG", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(y, m - 1, d)),
  )
}

/** Today in Lagos as YYYY-MM-DD, for the date input's minimum. */
export function todayInLagos() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos" }).format(new Date())
}

export const MOVEMENT_LABELS: Record<PocketMovement["kind"], string> = {
  deposit: "Added",
  withdrawal: "Withdrawn",
  auto_save: "Auto-saved",
  close: "Closed, returned to the account",
}
