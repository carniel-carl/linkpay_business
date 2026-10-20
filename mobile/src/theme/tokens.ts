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
  destructive: "#c52c2a",
  "destructive-foreground": "#b3261e",
  "destructive-subtle": "#ffedea",
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
  destructive: "#ffa8a0",
  "destructive-foreground": "#ffa8a0",
  "destructive-subtle": "#5c332f",
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
