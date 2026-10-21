"use client"

import { useLayoutEffect, useRef, useState } from "react"
import type { BusinessActivity } from "@/lib/api/types"
import { formatNaira } from "@/lib/format"

type Day = { day: string; inKobo: number; outKobo: number }

const HEIGHT = 200
const PAD = { top: 12, right: 8, bottom: 24, left: 56 }
const BAR_MAX = 12
const GAP = 2

const dayFmt = new Intl.DateTimeFormat("en-NG", { day: "numeric", month: "short", timeZone: "UTC" })
const longFmt = new Intl.DateTimeFormat("en-NG", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })
const asDate = (day: string) => new Date(`${day}T00:00:00Z`)

/** ₦0, ₦50K, ₦1.2M for axis ticks. */
function compactNaira(kobo: number) {
  const naira = kobo / 100
  if (naira >= 1e9) return `₦${trim(naira / 1e9)}B`
  if (naira >= 1e6) return `₦${trim(naira / 1e6)}M`
  if (naira >= 1e3) return `₦${trim(naira / 1e3)}K`
  return `₦${Math.round(naira)}`
}
const trim = (n: number) => (n >= 10 ? Math.round(n).toString() : n.toFixed(1).replace(/\.0$/, ""))

/** A clean max and step for 4 ticks: 1, 2 or 5 times a power of ten. */
function niceScale(max: number) {
  if (max <= 0) return { top: 100_00, step: 25_00 }
  const raw = max / 4
  const power = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= raw)!
  return { top: step * 4, step }
}

/** Every day of the 30 ending `today` (Lagos), with zeros for quiet days. */
function fillDays(daily: Day[], today: string): Day[] {
  const end = asDate(today)
  return Array.from({ length: 30 }, (_, i) => {
    const d = new Date(end)
    d.setUTCDate(d.getUTCDate() - (29 - i))
    const day = d.toISOString().slice(0, 10)
    return daily.find((x) => x.day === day) ?? { day, inKobo: 0, outKobo: 0 }
  })
}

/** A column with a 4px rounded top, square at the baseline. */
function column(x: number, y: number, w: number, h: number) {
  if (h <= 0) return ""
  const r = Math.min(4, w / 2, h)
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`
}

/**
 * Money in and out per day over 30 days: paired columns on one axis (both are naira), legend above, a
 * tooltip per day, and the same figures as a table for screen readers and anyone who prefers one.
 */
export function FlowChart({ daily, today }: { daily: BusinessActivity["daily"]; today: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [hover, setHover] = useState<number | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const days = fillDays(daily, today)
  const { top, step } = niceScale(Math.max(...days.map((d) => Math.max(d.inKobo, d.outKobo))))
  const plotW = Math.max(0, width - PAD.left - PAD.right)
  const plotH = HEIGHT - PAD.top - PAD.bottom
  const slot = plotW / days.length
  const bar = Math.max(2, Math.min(BAR_MAX, (slot - 6 - GAP) / 2))
  const y = (kobo: number) => PAD.top + plotH - (kobo / top) * plotH
  const ticks = [0, 1, 2, 3, 4].map((i) => i * step)
  const active = hover === null ? null : days[hover]

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-muted-foreground" aria-hidden>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-flow-in" />
          Money in
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-flow-out" />
          Money out
        </span>
      </div>

      <div ref={ref} className="relative" onMouseLeave={() => setHover(null)}>
        {width > 0 && (
          <svg width={width} height={HEIGHT} role="img" aria-label="Money in and out per day over the last 30 days. The figures are in the table below.">
            {ticks.map((t) => (
              <g key={t}>
                <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} className="stroke-border" strokeWidth={1} />
                <text x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-[11px] tabular-nums">
                  {compactNaira(t)}
                </text>
              </g>
            ))}
            {days.map((d, i) => {
              const cx = PAD.left + slot * i + slot / 2
              return (
                <g key={d.day}>
                  {hover === i && <rect x={PAD.left + slot * i} y={PAD.top} width={slot} height={plotH} className="fill-muted" opacity={0.7} />}
                  <path d={column(cx - bar - GAP / 2, y(d.inKobo), bar, plotH + PAD.top - y(d.inKobo))} className="fill-flow-in" />
                  <path d={column(cx + GAP / 2, y(d.outKobo), bar, plotH + PAD.top - y(d.outKobo))} className="fill-flow-out" />
                  {(i % 7 === 1 || i === days.length - 1) && (
                    <text x={cx} y={HEIGHT - 6} textAnchor="middle" className="fill-muted-foreground text-[11px]">
                      {i === days.length - 1 ? "Today" : dayFmt.format(asDate(d.day))}
                    </text>
                  )}
                  {/* The whole slot is the hover target, wider than the bars. */}
                  <rect
                    x={PAD.left + slot * i}
                    y={PAD.top}
                    width={slot}
                    height={plotH}
                    fill="transparent"
                    onMouseEnter={() => setHover(i)}
                  />
                </g>
              )
            })}
          </svg>
        )}
        {active && hover !== null && (
          <div
            className="pointer-events-none absolute top-0 z-10 grid min-w-44 gap-1.5 rounded-xl border bg-popover p-3 text-xs shadow-lg"
            style={{
              left: Math.min(Math.max(0, PAD.left + slot * hover + slot / 2 - 88), Math.max(0, width - 180)),
            }}
          >
            <span className="font-medium text-foreground">{longFmt.format(asDate(active.day))}</span>
            <span className="flex items-center justify-between gap-4">
              <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                <span className="size-2 rounded-sm bg-flow-in" />
                Money in
              </span>
              <span className="figure text-foreground">{formatNaira(active.inKobo)}</span>
            </span>
            <span className="flex items-center justify-between gap-4">
              <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                <span className="size-2 rounded-sm bg-flow-out" />
                Money out
              </span>
              <span className="figure text-foreground">{formatNaira(active.outKobo)}</span>
            </span>
          </div>
        )}
        {width === 0 && <div style={{ height: HEIGHT }} />}
      </div>

      <details className="text-sm">
        <summary className="w-fit cursor-pointer text-xs text-muted-foreground hover:text-foreground">View as a table</summary>
        <table className="mt-3 w-full text-xs">
          <caption className="sr-only">Money in and out per day, last 30 days</caption>
          <thead>
            <tr className="border-b text-muted-foreground">
              <th scope="col" className="py-1.5 text-left font-medium">Day</th>
              <th scope="col" className="py-1.5 text-right font-medium">Money in</th>
              <th scope="col" className="py-1.5 text-right font-medium">Money out</th>
            </tr>
          </thead>
          <tbody>
            {days
              .filter((d) => d.inKobo || d.outKobo)
              .reverse()
              .map((d) => (
                <tr key={d.day} className="border-b last:border-0">
                  <th scope="row" className="py-1.5 text-left font-normal">{longFmt.format(asDate(d.day))}</th>
                  <td className="py-1.5 text-right figure">{formatNaira(d.inKobo)}</td>
                  <td className="py-1.5 text-right figure">{formatNaira(d.outKobo)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </details>
    </div>
  )
}
