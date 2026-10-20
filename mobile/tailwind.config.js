// Colours are CSS variables set per colour scheme in src/theme/tokens.ts (vars() on the root view).
const token = (name) => `rgb(var(--${name}) / <alpha-value>)`;
const names = [
  "background", "foreground", "card", "card-foreground", "primary", "primary-foreground",
  "pop", "pop-foreground", "pop-subtle", "brand-subtle", "brand-surface", "brand-surface-foreground", "brand-surface-muted", "band", "band-foreground", "band-muted", "band-raised", "band-danger",
  "secondary", "muted", "muted-foreground", "border", "input", "ring",
  "success", "success-foreground", "success-subtle", "warning", "warning-foreground", "warning-subtle",
  "destructive", "destructive-foreground", "destructive-subtle",
];

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{ts,tsx}"],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      colors: Object.fromEntries(names.map((n) => [n, token(n)])),
      fontFamily: {
        display: ["BricolageDisplay-SemiBold"],
        "display-medium": ["BricolageDisplay-Medium"],
        "display-bold": ["BricolageDisplay-Bold"],
        figure: ["BricolageText-SemiBold"],
        "figure-medium": ["BricolageText-Medium"],
      },
      borderRadius: { field: "12px", sheet: "28px", surface: "20px", tile: "30%", tag: "6px" },
    },
  },
  plugins: [],
};
