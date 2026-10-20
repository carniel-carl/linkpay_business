"use client"

import { useRef } from "react"
import Image from "next/image"
import Link from "next/link"
import { ArrowRight } from "lucide-react"
import { motion, useMotionTemplate, useMotionValue, useScroll, useSpring, useTransform } from "motion/react"
import artisanStall from "@/assets/landing/artisan-stall.jpg"
import { Button } from "@/components/ui/button"
import { usePrefersReducedMotion } from "./use-media-query"

/** The frame opens out to the page edges as it scrolls in; the button leans toward the pointer. */
export function Closing() {
  const ref = useRef<HTMLElement>(null)
  const reduce = usePrefersReducedMotion()
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start end", "center center"] })
  const inset = useTransform(scrollYProgress, [0, 1], reduce ? [0, 0] : [10, 0])
  const radius = useTransform(scrollYProgress, [0, 1], reduce ? [28, 28] : [56, 28])
  const clipPath = useMotionTemplate`inset(0% ${inset}% round ${radius}px)`
  const scale = useTransform(scrollYProgress, [0, 1], reduce ? [1, 1] : [1.2, 1])

  return (
    <section ref={ref} className="px-3 pb-3 md:px-4 md:pb-4">
      <motion.div style={{ clipPath }} className="relative grid min-h-[min(88dvh,52rem)] place-items-center overflow-hidden">
        <motion.div style={{ scale }} className="absolute inset-0">
          <Image
            src={artisanStall}
            alt=""
            fill
            placeholder="blur"
            sizes="100vw"
            className="object-cover object-[50%_30%]"
          />
        </motion.div>
        {/* Fixed dark scrim: white copy on a photo must read the same in both themes. */}
        <div aria-hidden className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,oklch(0.18_0.03_252/0.78),oklch(0.18_0.03_252/0.45)_70%)]" />
        <div className="relative grid max-w-3xl justify-items-center gap-7 px-6 py-24 text-center text-[oklch(0.98_0.005_250)]">
          <h2 className="type-display text-[clamp(2.75rem,7vw,6.5rem)] text-balance">Open your business account</h2>
          <p className="max-w-[36ch] text-lg leading-relaxed text-white/80">
            Sign up in a few minutes. Verify whenever your documents are ready.
          </p>
          <Magnetic disabled={!!reduce}>
            <Button variant="pop" size="lg" className="h-14 px-8 text-base" asChild>
              <Link href="/sign-up">
                Open an account
                <ArrowRight data-icon="inline-end" aria-hidden />
              </Link>
            </Button>
          </Magnetic>
        </div>
      </motion.div>
    </section>
  )
}

function Magnetic({ children, disabled }: { children: React.ReactNode; disabled: boolean }) {
  const x = useMotionValue(0)
  const y = useMotionValue(0)
  const sx = useSpring(x, { stiffness: 150, damping: 15, mass: 0.2 })
  const sy = useSpring(y, { stiffness: 150, damping: 15, mass: 0.2 })

  return (
    <motion.div
      style={{ x: sx, y: sy }}
      className="p-4"
      onPointerMove={(e) => {
        if (disabled || e.pointerType !== "mouse") return
        const r = e.currentTarget.getBoundingClientRect()
        x.set((e.clientX - (r.left + r.width / 2)) * 0.3)
        y.set((e.clientY - (r.top + r.height / 2)) * 0.3)
      }}
      onPointerLeave={() => {
        x.set(0)
        y.set(0)
      }}
    >
      {children}
    </motion.div>
  )
}
