"use client"

import { motion } from "motion/react"
import { EASE_OUT } from "./motion"

/**
 * Rises into place the first time it scrolls into view. Server content can be passed as children.
 * Under reduced motion the MotionConfig in SmoothScroll drops the rise and keeps only the fade.
 */
export function Reveal({
  children,
  className,
  delay = 0,
  as = "div",
}: {
  children: React.ReactNode
  className?: string
  delay?: number
  as?: "div" | "li" | "article"
}) {
  const Tag = motion[as]
  return (
    <Tag
      className={className}
      initial={{ opacity: 0, y: 32 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.25 }}
      transition={{ duration: 0.9, ease: EASE_OUT, delay }}
    >
      {children}
    </Tag>
  )
}
