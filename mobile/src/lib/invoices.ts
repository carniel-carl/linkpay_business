// Invoice copy, dates and totals. Mirrors web/src/lib/invoices.ts; keep the two in step.
import type { InvoiceListItem, InvoiceStatus, PaymentMethod } from "@/lib/api/types";

export const INVOICE_TABS = [
  { key: "all", label: "All" },
  { key: "unpaid", label: "Unpaid" },
  { key: "overdue", label: "Overdue" },
  { key: "draft", label: "Drafts" },
  { key: "paid", label: "Paid" },
  { key: "void", label: "Void" },
] as const;
export type InvoiceTab = (typeof INVOICE_TABS)[number]["key"];

export const STATUS_LABELS: Record<InvoiceStatus, string> = {
  draft: "Draft",
  open: "Unpaid",
  partially_paid: "Part paid",
  paid: "Paid",
  void: "Void",
};

export const METHOD_LABELS: Record<PaymentMethod, string> = {
  transfer: "Bank transfer",
  cash: "Cash",
  pos: "POS",
  cheque: "Cheque",
  other: "Other",
};

/** "Overdue" wins over the stored status, since it's what needs doing. */
export const statusLabel = (invoice: Pick<InvoiceListItem, "status" | "overdue">) =>
  invoice.overdue ? "Overdue" : STATUS_LABELS[invoice.status];

export const isUnpaid = (invoice: Pick<InvoiceListItem, "status">) =>
  invoice.status === "open" || invoice.status === "partially_paid";

// ---- Dates: invoices use Lagos calendar days ("YYYY-MM-DD"), never times ----

const lagosDay = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Africa/Lagos",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const dayFmt = new Intl.DateTimeFormat("en-NG", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export const todayInLagos = (now = new Date()) => lagosDay.format(now);

export function addDays(day: string, days: number) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);

/** "2026-10-20" -> "20 Oct 2026" */
export const formatDay = (day?: string | null) => (day ? dayFmt.format(new Date(`${day}T12:00:00Z`)) : "");

/** "Due in 3 days", "Due today", "4 days overdue". */
export function dueLabel(dueDate: string, today = todayInLagos()) {
  const days = daysBetween(today, dueDate);
  if (days === 0) return "Due today";
  if (days === 1) return "Due tomorrow";
  if (days > 1) return `Due in ${days} days`;
  return days === -1 ? "1 day overdue" : `${-days} days overdue`;
}

// ---- Totals: mirrors the backend's computeTotals for the form's live total; the backend's figures count ----

export type DraftItem = { description: string; quantity: number; unitPriceKobo: number };
export type DraftDiscount = { type: "amount"; kobo: number } | { type: "percent"; bps: number } | null;

export function computeTotals(items: DraftItem[], discount: DraftDiscount, vatRateBps: number | null) {
  const lines = items.map((i) => ({ ...i, amountKobo: Math.round(i.quantity * i.unitPriceKobo) }));
  const subtotalKobo = lines.reduce((s, l) => s + l.amountKobo, 0);
  let discountKobo = 0;
  if (discount?.type === "amount") discountKobo = Math.min(discount.kobo, subtotalKobo);
  if (discount?.type === "percent") discountKobo = Math.round((subtotalKobo * discount.bps) / 10_000);
  const vatKobo = vatRateBps ? Math.round(((subtotalKobo - discountKobo) * vatRateBps) / 10_000) : 0;
  return { items: lines, subtotalKobo, discountKobo, vatKobo, totalKobo: subtotalKobo - discountKobo + vatKobo };
}

/** 750 -> "7.5" */
export const bpsToPercent = (bps: number) => String(bps / 100);

/** "7.5" -> 750, or null. Up to two decimal places, 0 to 100. */
export function parsePercentToBps(input: string): number | null {
  const match = /^(\d{1,3})(?:\.(\d{0,2}))?$/.exec(input.trim().replace(/%$/, ""));
  if (!match) return null;
  const bps = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return bps <= 10_000 ? bps : null;
}

/** Quantities: up to 2 decimal places ("1.5" hours), as the backend allows. */
export function parseQuantity(input: string): number | null {
  const text = input.trim().replace(/,/g, "");
  if (!/^\d{1,7}(?:\.\d{0,2})?$/.test(text)) return null;
  const n = Number(text);
  return n > 0 && n <= 1_000_000 ? n : null;
}

/** 150050 -> "1500.50", for putting an amount back into a field. */
export const koboToInput = (kobo: number) =>
  `${Math.trunc(kobo / 100)}${kobo % 100 ? `.${String(kobo % 100).padStart(2, "0")}` : ""}`;

/** "2.5" stays "2.5"; 3 -> "3". */
export const quantityToInput = (q: number) => String(q);

/** What the customer should put in the transfer narration so the payment matches by itself. */
export const narrationHint = (number: string) =>
  `Use ${number} as the transfer narration so we can match your payment.`;

// ---- Accent colours: mirrors accentPalette() in backend/src/services/branding.ts so previews recolour as you pick ----

export const DEFAULT_ACCENT = "#1F2937";

/** Colours that hold up on white paper and as a band behind white text. "Ink" is the backend's default. */
export const SWATCHES = [
  { name: "Ink", hex: "#1F2937" },
  { name: "Navy", hex: "#1E3A5F" },
  { name: "Blue", hex: "#1D4ED8" },
  { name: "Teal", hex: "#0F766E" },
  { name: "Green", hex: "#15803D" },
  { name: "Plum", hex: "#6D28D9" },
  { name: "Wine", hex: "#9F1239" },
  { name: "Rust", hex: "#C2410C" },
] as const;

const channels = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255] as const;
};
const toHex = (r: number, g: number, b: number) =>
  "#" +
  [r, g, b]
    .map((v) => Math.round(v).toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
function luminance(hex: string) {
  const [r, g, b] = channels(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrastRatio = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

export const isHexColor = (value: string) => /^#[0-9A-F]{6}$/i.test(value);

export function accentPalette(accent?: string | null) {
  const base = accent && isHexColor(accent) ? accent.toUpperCase() : DEFAULT_ACCENT;
  const onAccent = contrastRatio(base, "#FFFFFF") >= contrastRatio(base, "#111111") ? "#FFFFFF" : "#111111";
  let [r, g, b]: number[] = [...channels(base)];
  let accentText = base;
  for (let i = 0; i < 20 && contrastRatio(accentText, "#FFFFFF") < 4.5; i++) {
    [r, g, b] = [r * 0.85, g * 0.85, b * 0.85];
    accentText = toHex(r, g, b);
  }
  return { accent: base, onAccent, accentText };
}
