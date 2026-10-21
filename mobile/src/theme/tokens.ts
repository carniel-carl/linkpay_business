import { vars } from "nativewind";

/**
 * LinkPay Business "private ledger" tokens, converted from web/src/app/globals.css (OKLCH to sRGB).
 * `brand-surface` is the dashboard band, as on the web: pale in light, deep navy in dark. Mobile adds the
 * entrance band: a full navy field in both appearances behind auth, passcode and lock.
 * Lime (`pop`) is the logo tile, avatar fills and primary actions on navy; in dark mode it is also `primary`.
 */
const light = {
  background: "#f3f6f9",
  foreground: "#13202f",
  card: "#fdfeff",
  "card-foreground": "#13202f",
  primary: "#27394d",
  "primary-foreground": "#f6f8fb",
  pop: "#9ae600",
  "pop-foreground": "#102032",
  "pop-subtle": "#dff9c0",
  "brand-subtle": "#e2ecf7",
  "brand-surface": "#dee9f5",
  "brand-surface-foreground": "#152537",
  "brand-surface-muted": "#495766",
  band: "#27394d",
  "band-foreground": "#f4f7fb",
  "band-muted": "#afc0cf",
  "band-raised": "#1c2d3f",
  "band-danger": "#ffb4ab",
  secondary: "#ebeef2",
  muted: "#ebeff2",
  "muted-foreground": "#58616c",
  border: "#dce0e5",
  input: "#c2c8cf",
  ring: "#325780",
  success: "#1d7d3e",
  "success-foreground": "#115629",
  "success-subtle": "#d9f6d9",
  warning: "#e29936",
  "warning-foreground": "#7d460b",
  "warning-subtle": "#fff0d0",
  // Donation links: a rose of their own, so fundraisers are recognisable in lists (web: --donation*).
  donation: "#c3518d",
  "donation-foreground": "#913266",
  "donation-subtle": "#ffe5f2",
  destructive: "#c52c2a",
  "destructive-foreground": "#b3261e",
  "destructive-subtle": "#ffedea",
  // Invoice paper: the business's own document, so it stays white with neutral ink in both appearances (web: --paper*).
  paper: "#ffffff",
  "paper-ink": "#1c1f24",
  "paper-muted": "#606369",
  "paper-rule": "#dcdee1",
  "paper-tint": "#f6f7f8",
  // Savings pocket colours (keys from the API): a strong fill for progress and a subtle tile (web: --pocket-*).
  "pocket-lime": "#92ce14",
  "pocket-lime-subtle": "#e0f4c9",
  "pocket-green": "#2e9e52",
  "pocket-green-subtle": "#d0f7d6",
  "pocket-teal": "#00a19a",
  "pocket-teal-subtle": "#bdf9f4",
  "pocket-blue": "#2f8adc",
  "pocket-blue-subtle": "#ceefff",
  "pocket-violet": "#8e71d6",
  "pocket-violet-subtle": "#ede4ff",
  "pocket-pink": "#c65b93",
  "pocket-pink-subtle": "#ffdbf1",
  "pocket-orange": "#cb6620",
  "pocket-orange-subtle": "#ffe0c8",
  "pocket-amber": "#dc9e12",
  "pocket-amber-subtle": "#ffe8be",
  "pocket-slate": "#657383",
  "pocket-slate-subtle": "#ddedff",
};

export type TokenName = keyof typeof light;
export type Palette = Record<TokenName, string>;

const dark: Palette = {
  background: "#27394d",
  foreground: "#f4f7fb",
  card: "#354858",
  "card-foreground": "#f4f7fb",
  primary: "#9ae600",
  "primary-foreground": "#102032",
  pop: "#9ae600",
  "pop-foreground": "#102032",
  "pop-subtle": "#3c5d27",
  "brand-subtle": "#40586d",
  "brand-surface": "#1c2d3f",
  "brand-surface-foreground": "#f4f7fb",
  "brand-surface-muted": "#afc0cf",
  band: "#1c2d3f",
  "band-foreground": "#f4f7fb",
  "band-muted": "#afc0cf",
  "band-raised": "#27394d",
  "band-danger": "#ffb4ab",
  secondary: "#3a4d5d",
  muted: "#2e3f4f",
  "muted-foreground": "#bac6d1",
  border: "#465767",
  input: "#596b7c",
  ring: "#9ae600",
  success: "#9ae600",
  "success-foreground": "#abf051",
  "success-subtle": "#3a5d32",
  warning: "#fac463",
  "warning-foreground": "#fdd990",
  "warning-subtle": "#684d2c",
  donation: "#f89dc9",
  "donation-foreground": "#ffcce5",
  "donation-subtle": "#6d3a53",
  destructive: "#ffa8a0",
  "destructive-foreground": "#ffa8a0",
  "destructive-subtle": "#5c332f",
  // Invoice paper: the business's own document, so it stays white with neutral ink in both appearances (web: --paper*).
  paper: "#ffffff",
  "paper-ink": "#1c1f24",
  "paper-muted": "#606369",
  "paper-rule": "#dcdee1",
  "paper-tint": "#f6f7f8",
  // Savings pocket colours (web: --pocket-*, dark).
  "pocket-lime": "#a0e300",
  "pocket-lime-subtle": "#475a2e",
  "pocket-green": "#6fd087",
  "pocket-green-subtle": "#345d3e",
  "pocket-teal": "#00d3cb",
  "pocket-teal-subtle": "#135f5b",
  "pocket-blue": "#6dbdff",
  "pocket-blue-subtle": "#335578",
  "pocket-violet": "#bea4ff",
  "pocket-violet-subtle": "#554a75",
  "pocket-pink": "#f990c4",
  "pocket-pink-subtle": "#704258",
  "pocket-orange": "#fe9b61",
  "pocket-orange-subtle": "#71462e",
  "pocket-amber": "#e6ac3d",
  "pocket-amber-subtle": "#674e21",
  "pocket-slate": "#a5bad1",
  "pocket-slate-subtle": "#465463",
};

export const palettes = { light, dark } as const;
export type Scheme = keyof typeof palettes;

const toRgbTriplet = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
};

/** CSS variables for NativeWind, applied once on the root view. */
export const themeVars = {
  light: vars(Object.fromEntries(Object.entries(light).map(([k, v]) => [`--${k}`, toRgbTriplet(v)]))),
  dark: vars(Object.fromEntries(Object.entries(dark).map(([k, v]) => [`--${k}`, toRgbTriplet(v)]))),
};

/** Soft navy-tinted elevation, the web's `--shadow-surface`. Never pure black. */
export const shadows = {
  light: {
    surface: "0px 1px 2px rgba(28, 45, 63, 0.06), 0px 12px 32px -16px rgba(28, 45, 63, 0.24)",
    raised: "0px 1px 2px rgba(28, 45, 63, 0.08), 0px 18px 40px -18px rgba(28, 45, 63, 0.34)",
  },
  dark: {
    surface: "0px 1px 2px rgba(10, 18, 28, 0.3), 0px 14px 36px -16px rgba(10, 18, 28, 0.6)",
    raised: "0px 1px 2px rgba(10, 18, 28, 0.35), 0px 20px 44px -18px rgba(10, 18, 28, 0.7)",
  },
} as const;
