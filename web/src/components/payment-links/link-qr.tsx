"use client"

import { useEffect, useMemo, useState } from "react"
import { Download, QrCode } from "lucide-react"
import QRCode from "qrcode"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import type { BrandPalette, PaymentLink } from "@/lib/api/types"
import { priceLabel } from "@/lib/payment-links"

export type LinkBrand = { name: string; logoSrc: string | null; palette: BrandPalette }

type Matrix = { size: number; dark: (row: number, col: number) => boolean }

/** Modules of quiet zone around the code; scanners need at least 4. */
const QUIET = 4
/** The logo plate covers this share of the code's width. Level H recovers 30% damage, so this stays well clear. */
const LOGO_SHARE = 0.22
const INK = "#1c2633"
const MUTED = "#5b6675"

export function matrixFor(url: string, withLogo: boolean): Matrix {
  const { modules } = QRCode.create(url, { errorCorrectionLevel: withLogo ? "H" : "M" })
  return { size: modules.size, dark: (r, c) => modules.get(r, c) === 1 }
}

/** The logo plate in module units, centred: [start, size]. */
function plateFor(m: Matrix): [number, number] {
  let size = Math.ceil(m.size * LOGO_SHARE)
  if ((m.size - size) % 2) size += 1
  return [(m.size - size) / 2, size]
}

/** The code as SVG, in the business's colour, with its logo in the middle when it has one. */
export function qrSvg(m: Matrix, color: string, logoDataUrl: string | null) {
  const total = m.size + QUIET * 2
  let path = ""
  for (let r = 0; r < m.size; r++) for (let c = 0; c < m.size; c++) if (m.dark(r, c)) path += `M${c + QUIET} ${r + QUIET}h1v1h-1z`
  let logo = ""
  if (logoDataUrl) {
    const [start, size] = plateFor(m)
    const x = start + QUIET
    const pad = size * 0.12
    logo =
      `<rect x="${x}" y="${x}" width="${size}" height="${size}" rx="${size * 0.22}" fill="#fff"/>` +
      `<image href="${logoDataUrl}" x="${x + pad}" y="${x + pad}" width="${size - pad * 2}" height="${size - pad * 2}" preserveAspectRatio="xMidYMid meet"/>`
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges">` +
    `<rect width="${total}" height="${total}" fill="#fff"/><path d="${path}" fill="${color}"/>${logo}</svg>`
  )
}

/** Draws the code (with its quiet zone) at x, y, `width` pixels wide. */
function drawQr(ctx: CanvasRenderingContext2D, m: Matrix, x: number, y: number, width: number, color: string, logo: HTMLImageElement | null) {
  const total = m.size + QUIET * 2
  const px = width / total
  ctx.fillStyle = "#fff"
  ctx.fillRect(x, y, width, width)
  ctx.fillStyle = color
  for (let r = 0; r < m.size; r++) {
    for (let c = 0; c < m.size; c++) {
      // Whole pixels, so neighbouring modules meet without hairline gaps.
      if (!m.dark(r, c)) continue
      const x0 = Math.round(x + (c + QUIET) * px)
      const y0 = Math.round(y + (r + QUIET) * px)
      ctx.fillRect(x0, y0, Math.round(x + (c + QUIET + 1) * px) - x0, Math.round(y + (r + QUIET + 1) * px) - y0)
    }
  }
  if (logo) {
    const [start, size] = plateFor(m)
    const sx = x + (start + QUIET) * px
    const s = size * px
    ctx.fillStyle = "#fff"
    ctx.beginPath()
    ctx.roundRect(sx, sx - x + y, s, s, s * 0.22)
    ctx.fill()
    const pad = s * 0.12
    fitImage(ctx, logo, sx + pad, sx - x + y + pad, s - pad * 2, s - pad * 2)
  }
}

/** Draws an image inside a box, keeping its shape. */
function fitImage(ctx: CanvasRenderingContext2D, img: HTMLImageElement, x: number, y: number, w: number, h: number) {
  const scale = Math.min(w / img.naturalWidth, h / img.naturalHeight)
  const dw = img.naturalWidth * scale
  const dh = img.naturalHeight * scale
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh)
}

/** Splits text into at most `maxLines` lines that fit, ending with an ellipsis if it had to cut. */
function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number) {
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let line = ""
  for (let i = 0; i < words.length; i++) {
    const next = line ? `${line} ${words[i]}` : words[i]!
    if (ctx.measureText(next).width <= maxWidth || !line) {
      line = next
      continue
    }
    lines.push(line)
    line = words[i]!
    if (lines.length === maxLines) {
      line = ""
      const last = lines.pop()!
      let cut = last
      while (cut && ctx.measureText(`${cut}…`).width > maxWidth) cut = cut.slice(0, -1)
      lines.push(`${cut.trimEnd()}…`)
      break
    }
  }
  if (line && lines.length < maxLines) lines.push(line)
  return lines
}

/** The font families next/font registered, read from the page so the canvas uses the same faces. */
async function fonts() {
  const css = getComputedStyle(document.body)
  const display = css.getPropertyValue("--font-bricolage").trim() || "sans-serif"
  const sans = css.getPropertyValue("--font-geist-sans").trim() || "sans-serif"
  const mono = css.getPropertyValue("--font-geist-mono").trim() || "monospace"
  await Promise.all([document.fonts.load(`600 80px ${display}`), document.fonts.load(`500 40px ${sans}`), document.fonts.load(`400 30px ${mono}`)]).catch(() => {})
  return { display, sans, mono }
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = src
  })
}

async function toDataUrl(src: string) {
  const blob = await (await fetch(src)).blob()
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

const POSTER = { w: 1200, h: 1700 }

/**
 * A printable card: the business and what's being paid for on its colour, the code on white below,
 * and how to pay. 1200 × 1700 px, about A6 at 300 dpi.
 */
async function drawPoster(link: PaymentLink, brand: LinkBrand, m: Matrix, logo: HTMLImageElement | null) {
  const { display, sans, mono } = await fonts()
  const { palette } = brand
  const canvas = document.createElement("canvas")
  canvas.width = POSTER.w
  canvas.height = POSTER.h
  const ctx = canvas.getContext("2d")!
  const pad = 96

  ctx.fillStyle = "#fff"
  ctx.fillRect(0, 0, POSTER.w, POSTER.h)
  const band = 640
  ctx.fillStyle = palette.accent
  ctx.fillRect(0, 0, POSTER.w, band)

  // Business row.
  const tile = 88
  let nameX = pad
  if (logo) {
    ctx.fillStyle = "#fff"
    ctx.beginPath()
    ctx.roundRect(pad, pad, tile, tile, 26)
    ctx.fill()
    fitImage(ctx, logo, pad + 10, pad + 10, tile - 20, tile - 20)
    nameX = pad + tile + 28
  }
  ctx.fillStyle = palette.onAccent
  ctx.textBaseline = "middle"
  ctx.font = `500 40px ${sans}`
  ctx.fillText(wrap(ctx, brand.name, POSTER.w - nameX - pad, 1)[0] ?? "", nameX, pad + tile / 2)

  // Title and price.
  ctx.textBaseline = "alphabetic"
  ctx.font = `600 84px ${display}`
  const titleLines = wrap(ctx, link.title, POSTER.w - pad * 2, 2)
  let y = pad + tile + 140
  for (const line of titleLines) {
    ctx.fillText(line, pad, y)
    y += 92
  }
  ctx.globalAlpha = 0.9
  ctx.font = `600 60px ${display}`
  ctx.fillText(priceLabel(link), pad, y + 8)
  ctx.globalAlpha = 1

  // The code on a white card that overlaps the band.
  const card = 820
  const cardX = (POSTER.w - card) / 2
  const cardY = band - 150
  ctx.save()
  ctx.shadowColor = "rgba(20, 30, 45, 0.18)"
  ctx.shadowBlur = 48
  ctx.shadowOffsetY = 16
  ctx.fillStyle = "#fff"
  ctx.beginPath()
  ctx.roundRect(cardX, cardY, card, card, 40)
  ctx.fill()
  ctx.restore()
  const qrSize = card - 80
  drawQr(ctx, m, cardX + 40, cardY + 40, qrSize, palette.accentText, logo)

  // How to pay.
  ctx.textAlign = "center"
  ctx.fillStyle = INK
  ctx.font = `600 52px ${display}`
  ctx.fillText("Scan with your phone camera to pay", POSTER.w / 2, cardY + card + 110)
  ctx.fillStyle = MUTED
  ctx.font = `400 32px ${mono}`
  ctx.fillText(wrap(ctx, link.url.replace(/^https?:\/\//, ""), POSTER.w - pad * 2, 1)[0] ?? "", POSTER.w / 2, cardY + card + 170)
  ctx.font = `400 28px ${sans}`
  ctx.fillText(`Paid by bank transfer into ${brand.name}'s account. Secured by LinkPay Business.`, POSTER.w / 2, POSTER.h - 72, POSTER.w - pad * 2)
  return canvas
}

function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = name
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

const canvasBlob = (canvas: HTMLCanvasElement) => new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob"))), "image/png"))

/** The code alone, as a small inline SVG for the Share card. */
export function QrThumb({ url, color, className }: { url: string; color: string; className?: string }) {
  const svg = useMemo(() => qrSvg(matrixFor(url, false), color, null), [url, color])
  return <span role="img" aria-label="QR code for this link" className={className} dangerouslySetInnerHTML={{ __html: svg }} />
}

/** "QR code" button and dialog: a print-ready card, plus the bare code as PNG or SVG. */
export function LinkQrDialog({ link, brand, children }: { link: PaymentLink; brand: LinkBrand; children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const [poster, setPoster] = useState<{ canvas: HTMLCanvasElement; preview: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const withLogo = !!brand.logoSrc
  const matrix = useMemo(() => matrixFor(link.url, withLogo), [link.url, withLogo])
  const file = `linkpay-${link.slug}`

  useEffect(() => {
    if (!open || poster) return
    let live = true
    ;(async () => {
      const logo = brand.logoSrc ? await loadImage(brand.logoSrc).catch(() => null) : null
      const canvas = await drawPoster(link, brand, logo ? matrix : matrixFor(link.url, false), logo)
      if (live) setPoster({ canvas, preview: canvas.toDataURL("image/png") })
    })().catch(() => toast.error("We couldn't draw the QR code. Refresh and try again."))
    return () => {
      live = false
    }
  }, [open, poster, link, brand, matrix])

  async function run(kind: string, fn: () => Promise<void>) {
    setBusy(kind)
    try {
      await fn()
    } catch {
      toast.error("We couldn't make that file. Try again.")
    } finally {
      setBusy(null)
    }
  }

  const downloadPoster = () => run("poster", async () => save(await canvasBlob(poster!.canvas), `${file}-card.png`))

  const downloadPng = () =>
    run("png", async () => {
      const logo = brand.logoSrc ? await loadImage(brand.logoSrc).catch(() => null) : null
      const canvas = document.createElement("canvas")
      canvas.width = canvas.height = 1200
      drawQr(canvas.getContext("2d")!, logo ? matrix : matrixFor(link.url, false), 0, 0, 1200, brand.palette.accentText, logo)
      save(await canvasBlob(canvas), `${file}-qr.png`)
    })

  const downloadSvg = () =>
    run("svg", async () => {
      const logo = brand.logoSrc ? await toDataUrl(brand.logoSrc).catch(() => null) : null
      save(new Blob([qrSvg(logo ? matrix : matrixFor(link.url, false), brand.palette.accentText, logo)], { type: "image/svg+xml" }), `${file}-qr.svg`)
    })

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        // Branding or the title may have changed since; draw it again next time.
        if (!next) setPoster(null)
      }}
    >
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>QR code</DialogTitle>
          <DialogDescription>Customers scan it with their phone camera and land on this link&apos;s page. No app needed.</DialogDescription>
        </DialogHeader>
        <div className="grid items-start gap-6 sm:grid-cols-[minmax(0,1fr)_minmax(0,16rem)]">
          <div className="grid aspect-[12/17] place-items-center overflow-hidden rounded-[14px] bg-muted">
            {poster ? (
              // eslint-disable-next-line @next/next/no-img-element -- a canvas drawing, not a remote image
              <img src={poster.preview} alt={`Printable card for ${link.title} with its QR code`} className="size-full object-contain" />
            ) : (
              <Spinner />
            )}
          </div>
          <div className="grid gap-5">
            <div className="grid gap-2">
              <p className="text-sm font-medium">Card to print</p>
              <p className="text-sm text-muted-foreground">Your logo, the title, the price and the code, sized for A6. Put it on the counter, a flyer or a book launch table.</p>
              <Button onClick={downloadPoster} disabled={!poster || !!busy} className="w-fit">
                {busy === "poster" ? <Spinner /> : <Download data-icon="inline-start" aria-hidden />}
                Download card
              </Button>
            </div>
            <div className="grid gap-2 border-t pt-5">
              <p className="text-sm font-medium">Just the code</p>
              <p className="text-sm text-muted-foreground">For your own designs. SVG stays sharp at any size.</p>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={downloadPng} disabled={!!busy}>
                  {busy === "png" ? <Spinner /> : <QrCode data-icon="inline-start" aria-hidden />}
                  PNG
                </Button>
                <Button variant="outline" size="sm" onClick={downloadSvg} disabled={!!busy}>
                  {busy === "svg" ? <Spinner /> : <QrCode data-icon="inline-start" aria-hidden />}
                  SVG
                </Button>
              </div>
            </div>
            <p className="border-t pt-5 text-xs text-muted-foreground">
              Print it at least 3 cm wide, and scan it with your own phone before printing many. Editing the link doesn&apos;t change the code. If you turn
              the link off, the page it opens says it isn&apos;t taking payments.
            </p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
