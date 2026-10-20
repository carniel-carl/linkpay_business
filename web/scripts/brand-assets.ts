/**
 * Renders every logo asset (web favicons, mobile app icon, splash, Android adaptive icon and the
 * tintable mark used by the mobile LogoTile) from the one vector below.
 *
 *   cd web && bun scripts/brand-assets.ts
 *
 * The mark is the LinkPay bridge, traced from link_pay/public/images/logo.png (500px, white on
 * transparent). Keep MARK_PATH in sync with src/components/brand/logo.tsx.
 */
import sharp from "sharp"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export const MARK_PATH = "M0 0H374V144H345.6C332.9 97.7 291 26 187 26S41.1 97.7 28.4 144H0Z"
const MARK_W = 374
const MARK_H = 144

// Colours already used by the app icon and splash (lime tile, ink mark).
const LIME = "#a8e600"
const INK = "#132b41"
// The web's navy primary, for the bare favicon mark (as on the LinkPay site).
const NAVY = "#27394d"

// The mark spans this share of a tile's width. The mobile LogoTile and launch overlay use the same ratio.
const TILE_MARK = 0.58
// Browser tab icons are 16-32px, where the bridge's legs need more room to survive.
const FAVICON_MARK = 0.72
// The web favicon is the bare bridge across most of the square, like the LinkPay site's.
const WEB_FAVICON_MARK = 0.9
const TILE_RADIUS = 0.3

const root = fileURLToPath(new URL("../..", import.meta.url))
const web = (p: string) => join(root, "web", p)
const mobile = (p: string) => join(root, "mobile", p)

function mark(cx: number, cy: number, width: number, fill: string) {
  const round = (n: number) => +n.toFixed(4)
  const s = round(width / MARK_W)
  const x = round(cx - width / 2)
  const y = round(cy - (MARK_H * s) / 2)
  return `<path fill="${fill}" transform="translate(${x} ${y}) scale(${s})" d="${MARK_PATH}"/>`
}

function svg(size: number, body: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${body}</svg>`
}

/** A lime squircle tile of `tileSize` px centred on a `size` canvas, mark inside. */
function tile(size: number, tileSize = size, markRatio = TILE_MARK) {
  const o = (size - tileSize) / 2
  const r = tileSize * TILE_RADIUS
  return svg(
    size,
    `<rect x="${o}" y="${o}" width="${tileSize}" height="${tileSize}" rx="${r}" fill="${LIME}"/>` +
      mark(size / 2, size / 2, tileSize * markRatio, INK),
  )
}

/** Full-bleed square (iOS and Apple touch icons: the system rounds the corners). */
function square(size: number) {
  return svg(size, `<rect width="${size}" height="${size}" fill="${LIME}"/>` + mark(size / 2, size / 2, size * TILE_MARK, INK))
}

/** Rasterises at high density, then downsizes to `width` (default: the SVG's own width) for clean edges. */
async function png(file: string, source: string, width = Number(/width="([\d.]+)"/.exec(source)![1])) {
  await mkdir(dirname(file), { recursive: true })
  await sharp(Buffer.from(source), { density: 300 }).resize(width).png({ compressionLevel: 9 }).toFile(file)
}

/** ICO with embedded PNG images (supported by every current browser). */
async function ico(file: string, source: string, sizes: number[]) {
  const images = await Promise.all(sizes.map((s) => sharp(Buffer.from(source), { density: 300 }).resize(s).png().toBuffer()))
  const header = Buffer.alloc(6 + 16 * images.length)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  let offset = header.length
  images.forEach((buf, i) => {
    const e = 6 + 16 * i
    header.writeUInt8(sizes[i] >= 256 ? 0 : sizes[i], e)
    header.writeUInt8(sizes[i] >= 256 ? 0 : sizes[i], e + 1)
    header.writeUInt16LE(1, e + 4)
    header.writeUInt16LE(32, e + 6)
    header.writeUInt32LE(buf.length, e + 8)
    header.writeUInt32LE(offset, e + 12)
    offset += buf.length
  })
  await writeFile(file, Buffer.concat([header, ...images]))
}

// Web: Next.js picks these up from the app directory (favicon.ico, icon.svg, apple-icon.png).
// Tabs get the bare navy bridge; the SVG turns lime on dark browser chrome. The home-screen icon is the app's tile.
await ico(web("src/app/favicon.ico"), svg(48, mark(24, 24, 48 * WEB_FAVICON_MARK, NAVY)), [16, 32, 48])
await writeFile(
  web("src/app/icon.svg"),
  svg(
    32,
    `<style>path{fill:${NAVY}}@media (prefers-color-scheme:dark){path{fill:${LIME}}}</style>` + mark(16, 16, 32 * WEB_FAVICON_MARK, NAVY),
  ) + "\n",
)
await png(web("src/app/apple-icon.png"), square(180))

// Mobile app icon (iOS masks it), splash (tile at 800/1024, as app.json's imageWidth expects) and web favicon.
await png(mobile("assets/images/icon.png"), square(1024))
await png(mobile("assets/images/splash-icon.png"), tile(1024, 800))
await png(mobile("assets/images/favicon.png"), tile(48, 48, FAVICON_MARK))

// Android adaptive icon: lime background, ink mark inside the 66dp safe zone, alpha-only monochrome.
const ANDROID_MARK = 512
await png(mobile("assets/images/android-icon-background.png"), svg(1024, `<rect width="1024" height="1024" fill="${LIME}"/>`))
await png(mobile("assets/images/android-icon-foreground.png"), svg(1024, mark(512, 512, ANDROID_MARK, INK)))
await png(mobile("assets/images/android-icon-monochrome.png"), svg(1024, mark(512, 512, ANDROID_MARK, "#000")))

// The bare mark in white, for the mobile LogoTile (tinted at runtime with tintColor).
await png(
  mobile("assets/images/logo-mark.png"),
  `<svg xmlns="http://www.w3.org/2000/svg" width="${MARK_W}" height="${MARK_H}" viewBox="0 0 ${MARK_W} ${MARK_H}"><path fill="#fff" d="${MARK_PATH}"/></svg>`,
  600,
)

console.log("Brand assets written.")
