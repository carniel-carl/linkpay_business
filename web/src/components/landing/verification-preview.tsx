"use client"

import { useEffect, useRef, useState } from "react"
import { Check } from "lucide-react"
import { AnimatePresence, animate, motion, useInView, useMotionValue, useTransform } from "motion/react"
import { StatusBadge } from "@/components/business/status-badge"
import { cn } from "@/lib/utils"
import { EASE_OUT, SPRING } from "./motion"
import { usePrefersReducedMotion } from "./use-media-query"

// An example business, shown in the same shape as the real Home verification card.
const ITEMS = ["CAC certificate", "TIN certificate", "Owner's ID and BVN", "Proof of address"]
const STEP_MS = 520

/**
 * A working miniature of the dashboard's verification card: when it scrolls into view the four
 * requirements tick off in turn, the count climbs, and the status moves from In review to Verified.
 * Plays once. Reduced motion shows the finished state.
 */
export function VerificationPreview() {
  const ref = useRef<HTMLDivElement>(null)
  const inView = useInView(ref, { once: true, amount: 0.5 })
  const reduce = usePrefersReducedMotion()
  const [ticked, setTicked] = useState(0)
  const count = useMotionValue(0)
  const shown = useTransform(count, (v) => Math.round(v))
  const fill = useTransform(count, [0, ITEMS.length], [0, 1])

  useEffect(() => {
    if (reduce) {
      // After hydration (server and client both start at 0), jump straight to the finished state.
      count.set(ITEMS.length)
      const t = setTimeout(() => setTicked(ITEMS.length))
      return () => clearTimeout(t)
    }
    if (!inView) return
    // Discrete steps (four ticks), so state here is fine; the count itself animates as a motion value.
    const timers = ITEMS.map((_, i) => setTimeout(() => setTicked(i + 1), 500 + i * STEP_MS))
    const controls = animate(count, ITEMS.length, { duration: (ITEMS.length * STEP_MS) / 1000, delay: 0.5, ease: "easeInOut" })
    return () => {
      timers.forEach(clearTimeout)
      controls.stop()
    }
  }, [inView, reduce, count])

  const done = ticked
  const verified = done === ITEMS.length

  return (
    <div ref={ref} className="grid gap-6 rounded-[1.5rem] bg-card p-6 shadow-surface sm:p-7" aria-label="Example of a business being verified">
      <div className="flex items-start justify-between gap-4">
        <div className="grid gap-1">
          <p className="font-display text-lg font-semibold tracking-[-0.02em]">Ìtàn Crafts</p>
          <p className="text-sm text-muted-foreground">Sole proprietorship</p>
        </div>
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={verified ? "approved" : "submitted"}
            initial={{ opacity: 0, scale: 0.9, y: 6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, y: -6 }}
            transition={{ duration: 0.35, ease: EASE_OUT, delay: verified ? 0.35 : 0 }}
          >
            <StatusBadge status={verified ? "approved" : "submitted"} />
          </motion.span>
        </AnimatePresence>
      </div>

      <div className="grid gap-3">
        <div className="flex items-end gap-2.5">
          <motion.span className="type-display text-5xl leading-none figure">{shown}</motion.span>
          <span className="pb-1 text-sm text-muted-foreground figure">of {ITEMS.length} requirements</span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <motion.div style={{ scaleX: fill }} className="h-full origin-left rounded-full bg-primary" />
        </div>
      </div>

      <ul className="grid gap-1">
        {ITEMS.map((item, i) => {
          const on = i < done
          return (
            <li key={item} className="flex items-center gap-3 rounded-xl px-1 py-2">
              <span
                className={cn(
                  "grid size-7 shrink-0 place-items-center rounded-[9px] transition-colors duration-300",
                  on ? "bg-primary text-primary-foreground" : "bg-muted text-transparent",
                )}
              >
                <AnimatePresence initial={false}>
                  {on && (
                    <motion.span initial={{ scale: 0, rotate: -30 }} animate={{ scale: 1, rotate: 0 }} transition={SPRING}>
                      <Check className="size-3.5" strokeWidth={3} aria-hidden />
                    </motion.span>
                  )}
                </AnimatePresence>
              </span>
              <span className={cn("text-[15px] transition-colors duration-300", on ? "text-foreground" : "text-muted-foreground")}>
                {item}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
