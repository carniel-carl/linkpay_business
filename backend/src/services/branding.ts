import { randomBytes } from "node:crypto";
import sharp, { type Metadata } from "sharp";
import type { BusinessDocument } from "../models/Business";
import { HttpError } from "../utils/HttpError";
import { readFile, removeFile, saveFile } from "./storage";

/** Used when a business hasn't picked an accent colour: a neutral ink that reads as nobody's brand. */
export const DEFAULT_ACCENT = "#1F2937";

const LOGO_FORMATS = new Set(["png", "jpeg", "webp", "svg"]);
// Big enough for a crisp PDF header at 2x; anything larger is scaled down.
const LOGO_MAX = { width: 1200, height: 480 };

/**
 * Turns an uploaded logo into a trimmed PNG. SVGs are rasterised here, so scripts or external
 * references in them never reach a browser. Returns the PNG and a suggested accent colour.
 */
export async function processLogo(input: Buffer) {
  let meta: Metadata;
  try {
    meta = await sharp(input).metadata();
  } catch {
    throw new HttpError(400, "That file isn't an image we can read. Use PNG, JPG, WebP or SVG.", "UNSUPPORTED_FILE_TYPE");
  }
  if (!meta.format || !LOGO_FORMATS.has(meta.format)) {
    throw new HttpError(400, "Use a PNG, JPG, WebP or SVG logo", "UNSUPPORTED_FILE_TYPE");
  }

  // SVGs are rendered at a high density so small viewBoxes still come out sharp.
  const image = sharp(input, { density: meta.format === "svg" ? 300 : undefined, limitInputPixels: 40_000_000 })
    .rotate()
    .trim({ threshold: 10 })
    .resize({ ...LOGO_MAX, fit: "inside", withoutEnlargement: true });
  const { data, info } = await image.png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true });
  if (info.width < 16 || info.height < 16) throw new HttpError(400, "That logo is too small. Use one at least 64 pixels wide.", "LOGO_TOO_SMALL");

  return { png: data, width: info.width, height: info.height, suggestedAccent: await suggestAccent(data) };
}

/** The logo's most common colour that isn't close to white, black or grey; null for monochrome logos. */
async function suggestAccent(png: Buffer): Promise<string | null> {
  const { data, info } = await sharp(png).resize(64, 64, { fit: "inside" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const buckets = new Map<string, { n: number; r: number; g: number; b: number }>();
  for (let i = 0; i < data.length; i += info.channels) {
    const [r, g, b, a] = [data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!];
    if (a < 128) continue;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max - min < 40 || max < 40 || min > 225) continue; // grey, near black or near white
    const key = `${r >> 4},${g >> 4},${b >> 4}`;
    const bucket = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    bucket.n++;
    bucket.r += r;
    bucket.g += g;
    bucket.b += b;
    buckets.set(key, bucket);
  }
  const top = [...buckets.values()].sort((a, b) => b.n - a.n)[0];
  if (!top || top.n < 8) return null;
  return toHex(top.r / top.n, top.g / top.n, top.b / top.n);
}

const toHex = (r: number, g: number, b: number) =>
  "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("").toUpperCase();

function channels(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255] as const;
}

/** WCAG relative luminance. */
function luminance(hex: string) {
  const [r, g, b] = channels(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

/**
 * Colours for a document in the business's accent: `accent` for bands and fills, `onAccent` for text on
 * them, and `accentText` for accent-coloured text on white (darkened until it's readable).
 */
export function accentPalette(accent?: string | null) {
  const base = accent && /^#[0-9A-F]{6}$/i.test(accent) ? accent.toUpperCase() : DEFAULT_ACCENT;
  const onAccent = contrast(base, "#FFFFFF") >= contrast(base, "#111111") ? "#FFFFFF" : "#111111";
  let [r, g, b] = channels(base);
  let accentText = base;
  for (let i = 0; i < 20 && contrast(accentText, "#FFFFFF") < 4.5; i++) {
    [r, g, b] = [r * 0.85, g * 0.85, b * 0.85];
    accentText = toHex(r, g, b);
  }
  return { accent: base, onAccent, accentText };
}

// ---------------------------------------------------------------------------------------------------------

export async function saveLogo(business: BusinessDocument, input: Buffer) {
  const { png, width, height, suggestedAccent } = await processLogo(input);
  const previous = business.branding?.logo?.key;
  const key = `branding/${business.id}/logo-${randomBytes(6).toString("hex")}.png`;
  await saveFile(key, png);
  business.set("branding.logo", { key, width, height, updatedAt: new Date() });
  // The first logo sets the accent colour unless one was chosen already.
  if (!business.branding?.accentColor && suggestedAccent) business.set("branding.accentColor", suggestedAccent);
  await business.save();
  if (previous) await removeFile(previous).catch(() => {});
  return { suggestedAccent };
}

export async function deleteLogo(business: BusinessDocument) {
  const key = business.branding?.logo?.key;
  business.set("branding.logo", undefined);
  await business.save();
  if (key) await removeFile(key).catch(() => {});
}

export async function readLogo(business: { branding?: { logo?: { key?: string | null } | null } | null }) {
  const key = business.branding?.logo?.key;
  if (!key) return null;
  return readFile(key).catch(() => null);
}

/** The branding settings as clients see them, with defaults filled in. */
export function describeBranding(business: BusinessDocument, apiPath = "/api/branding/logo") {
  const b = business.branding;
  const logo = b?.logo?.key
    ? { url: `${apiPath}?v=${b.logo.updatedAt?.getTime() ?? 0}`, width: b.logo.width, height: b.logo.height }
    : null;
  return {
    logo,
    accentColor: b?.accentColor ?? null,
    palette: accentPalette(b?.accentColor),
    invoice: {
      prefix: b?.invoice?.prefix || "INV",
      defaultDueDays: b?.invoice?.defaultDueDays ?? 14,
      vatRateBps: b?.invoice?.vatRateBps ?? 750,
      vatByDefault: b?.invoice?.vatByDefault ?? false,
      notes: b?.invoice?.notes ?? null,
      terms: b?.invoice?.terms ?? null,
      footer: b?.invoice?.footer ?? null,
    },
  };
}
