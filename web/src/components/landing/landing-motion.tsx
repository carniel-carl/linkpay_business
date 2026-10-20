"use client"

import { useEffect } from "react"
import Lenis from "lenis"
import { MotionConfig } from "motion/react"
import { usePrefersReducedMotion } from "./use-media-query"

/**
 * Landing-page motion setup: inertial scrolling (off for reduced motion), and MotionConfig so that,
 * for reduced motion, entrances keep their fade but lose all movement.
 */
export function LandingMotion({ children }: { children: React.ReactNode }) {
  return (
    <MotionConfig reducedMotion="user">
      <SmoothScroll />
      {children}
    </MotionConfig>
  )
}

function SmoothScroll() {
  const reduce = usePrefersReducedMotion()

  useEffect(() => {
    if (reduce) return
    const lenis = new Lenis({ autoRaf: true, anchors: { offset: -72 }, lerp: 0.11 })
    return () => lenis.destroy()
  }, [reduce])

  return null
}
