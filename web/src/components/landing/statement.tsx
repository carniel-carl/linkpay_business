"use client"

import { useRef } from "react"
import { motion, useScroll, useTransform, type MotionValue } from "motion/react"
import { usePrefersReducedMotion } from "./use-media-query"

const TEXT =
  "Most business accounts start with a queue at the branch. Yours starts with your CAC number, a few documents and a review you can follow online."

// The words that carry the idea stay navy; the rest settle a shade lighter.
const STRONG = new Set(["queue", "branch.", "CAC", "number,", "review", "online."])

/** Words light up in reading order as the paragraph passes through the viewport. */
export function Statement() {
  const ref = useRef<HTMLParagraphElement>(null)
  const reduce = usePrefersReducedMotion()
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start 0.85", "end 0.4"] })
  const words = TEXT.split(" ")

  return (
    <section className="mx-auto max-w-[1400px] px-4 py-24 md:px-8 md:py-40">
      <p
        ref={ref}
        className="type-display max-w-[22ch] text-[clamp(2rem,4.6vw,4.5rem)] leading-[1.08]! font-medium! tracking-[-0.03em]!"
      >
        {words.map((word, i) => (
          <Word
            key={i}
            progress={scrollYProgress}
            range={[i / words.length, (i + 1) / words.length]}
            strong={STRONG.has(word)}
            reduce={!!reduce}
          >
            {word}
          </Word>
        ))}
      </p>
    </section>
  )
}

function Word({
  children,
  progress,
  range,
  strong,
  reduce,
}: {
  children: string
  progress: MotionValue<number>
  range: [number, number]
  strong: boolean
  reduce: boolean
}) {
  const opacity = useTransform(progress, range, [0.14, 1])
  return (
    <>
      <motion.span style={{ opacity: reduce ? 1 : opacity }} className={strong ? "text-foreground" : "text-foreground/60"}>
        {children}
      </motion.span>{" "}
    </>
  )
}
