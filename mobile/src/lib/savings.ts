// Savings pockets: labels and helpers shared by the Savings screens. Copy mirrors web/src/lib/savings.ts.
import type { ComponentProps } from "react";
import type { Icon } from "@/components/ui/icon";
import type { Pocket, PocketColor, PocketIcon, PocketMovement } from "@/lib/api/types";
import { formatNaira } from "@/lib/format";
import type { TokenName } from "@/theme/tokens";

/** Colour keys the API accepts, in the order the picker shows them. */
export const POCKET_COLORS: PocketColor[] = ["lime", "green", "teal", "blue", "violet", "pink", "orange", "amber", "slate"];

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
};

/** The theme tokens for a pocket's colour: a strong fill (progress) and a subtle tile. */
export const pocketTokens = (color: PocketColor) => ({
  fill: `pocket-${color}` as TokenName,
  subtle: `pocket-${color}-subtle` as TokenName,
});

type Glyph = Pick<ComponentProps<typeof Icon>, "ios" | "android">;

/** Icons offered in the picker, in order: things businesses save for. Keys match the API's `icon` (and the web's Lucide set). */
export const POCKET_ICONS: Record<PocketIcon, { label: string } & Glyph> = {
  savings: { label: "Savings", ios: "banknote", android: "savings" },
  tax: { label: "Tax", ios: "receipt", android: "receipt_long" },
  payroll: { label: "Payroll", ios: "person.2", android: "group" },
  rent: { label: "Rent", ios: "building.2", android: "apartment" },
  shop: { label: "Shop", ios: "storefront", android: "storefront" },
  stock: { label: "Stock", ios: "shippingbox", android: "inventory_2" },
  delivery: { label: "Delivery", ios: "truck.box", android: "local_shipping" },
  power: { label: "Power", ios: "bolt", android: "bolt" },
  repairs: { label: "Repairs", ios: "wrench.and.screwdriver", android: "build" },
  equipment: { label: "Equipment", ios: "laptopcomputer", android: "laptop" },
  vehicle: { label: "Vehicle", ios: "car", android: "directions_car" },
  travel: { label: "Travel", ios: "airplane", android: "flight" },
  marketing: { label: "Marketing", ios: "megaphone", android: "campaign" },
  growth: { label: "Growth", ios: "chart.line.uptrend.xyaxis", android: "trending_up" },
  emergency: { label: "Emergency fund", ios: "shield", android: "shield" },
  loan: { label: "Loan", ios: "building.columns", android: "account_balance" },
  training: { label: "Training", ios: "graduationcap", android: "school" },
  health: { label: "Health", ios: "cross.case", android: "medical_services" },
  events: { label: "Events", ios: "calendar", android: "event" },
  goal: { label: "Goal", ios: "flag", android: "flag" },
};

export const POCKET_ICON_KEYS = Object.keys(POCKET_ICONS) as PocketIcon[];

export const MAX_POCKETS_PER_BRANCH = 20;

/** 550 -> "5.5%", 1000 -> "10%". */
export const formatPercent = (bps: number) => `${(bps / 100).toLocaleString("en-NG", { maximumFractionDigits: 2 })}%`;

/** "5% of every payment in" or "₦2,000.00 from every payment in". */
export function describeAutoSave(autoSave: Pocket["autoSave"]) {
  if (!autoSave) return null;
  if (autoSave.percentBps !== null) return `${formatPercent(autoSave.percentBps)} of every payment in`;
  return `${formatNaira(autoSave.amountKobo)} from every payment in`;
}

/** Short tag for cards: "Auto-saving 5%". */
export function autoSaveTag(autoSave: Pocket["autoSave"]) {
  if (!autoSave) return null;
  return autoSave.percentBps !== null ? `Auto-saving ${formatPercent(autoSave.percentBps)}` : "Auto-saving";
}

export const MOVEMENT_LABELS: Record<PocketMovement["kind"], string> = {
  deposit: "Added",
  withdrawal: "Withdrawn",
  auto_save: "Auto-saved",
  close: "Closed, returned to the account",
};
