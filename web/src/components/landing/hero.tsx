"use client"

import { useRef } from "react"
import Image, { type StaticImageData } from "next/image"
import Link from "next/link"
import { ArrowRight } from "lucide-react"
import { motion, useScroll, useTransform, type MotionValue } from "motion/react"
import artisanStall from "@/assets/landing/artisan-stall.jpg"
import founderDesk from "@/assets/landing/founder-desk.jpg"
import market from "@/assets/landing/market.jpg"
import { Button } from "@/components/ui/button"
import { EASE_OUT } from "./motion"
import { usePrefersReducedMotion } from "./use-media-query"

const LINES = ["Banking for the way", "Nigeria trades."]

const COLUMNS: { src: StaticImageData; alt: string; position: string; offset: string; drift: number }[] = [
  {
    src: market,
    alt: "Traders at an open-air market, one selling sliced watermelon from a wheelbarrow",
    position: "50% 62%",
    offset: "h-[84%] self-end",
    drift: -40,
  },
  {
    src: artisanStall,
    alt: "A smiling trader in an orange headwrap behind her stall of handmade soaps and baskets",
    position: "50% 28%",
    offset: "h-full",
    drift: -110,
  },
  {
    src: founderDesk,
    alt: "A business owner smiling at her desk with a laptop and notebooks",
    position: "46% 40%",
    offset: "h-[68%] self-center",
    drift: -20,
  },
]

export function Hero() {
  const ref = useRef<HTMLElement>(null)
  const reduce = usePrefersReducedMotion()
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end start"] })

  return (
    <section
      ref={ref}
      className="relative mx-auto grid max-w-[1400px] gap-12 px-4 pt-28 pb-16 md:px-8 lg:min-h-[min(100dvh,60rem)] lg:grid-cols-12 lg:items-center lg:gap-10 lg:pt-28 lg:pb-12"
    >
      <div className="grid gap-7 lg:col-span-6 lg:pr-6">
        <h1 className="type-display text-[clamp(2.5rem,5.6vw,5.75rem)] leading-[0.98]! whitespace-nowrap">
          {LINES.map((line, i) => (
            <span key={line} className="block overflow-hidden pb-[0.08em]">
              <motion.span
                className="block"
                initial={{ y: "105%" }}
                animate={{ y: "0%" }}
                transition={{ duration: 1, ease: EASE_OUT, delay: 0.15 + i * 0.12 }}
              >
                {i === 1 ? (
                  <>
                    Nigeria{" "}
                    <span className="relative isolate inline-block text-pop-foreground">
                      <motion.span
                        aria-hidden
                        className="absolute inset-x-[-0.08em] top-[0.14em] bottom-[0.02em] -z-10 origin-left rounded-[0.14em] bg-pop"
                        initial={{ scaleX: 0 }}
                        animate={{ scaleX: 1 }}
                        transition={{ duration: 0.9, ease: EASE_OUT, delay: 0.95 }}
                      />
                      trades.
                    </span>
                  </>
                ) : (
                  line
                )}
              </motion.span>
            </span>
          ))}
        </h1>
        <motion.p
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.9, ease: EASE_OUT, delay: 0.55 }}
          className="max-w-[40ch] text-lg leading-relaxed text-muted-foreground"
        >
          Verify once with your CAC documents. Then run payments, invoices and branches from one account.
        </motion.p>
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.9, ease: EASE_OUT, delay: 0.7 }}
          className="flex flex-wrap gap-3"
        >
          <Button size="lg" className="h-12 px-6 text-[15px]" asChild>
            <Link href="/sign-up">
              Open an account
              <ArrowRight data-icon="inline-end" className="transition-transform duration-300 group-hover/button:translate-x-0.5" aria-hidden />
            </Link>
          </Button>
          <Button size="lg" variant="outline" className="h-12 px-6 text-[15px]" asChild>
            <Link href="/sign-in">Sign in</Link>
          </Button>
        </motion.div>
      </div>

      <div className="grid h-[22rem] grid-cols-3 gap-2.5 sm:h-[30rem] sm:gap-3 lg:col-span-6 lg:h-[min(68dvh,40rem)]">
        {COLUMNS.map((col, i) => (
          <PhotoColumn key={col.alt} {...col} index={i} progress={scrollYProgress} reduce={!!reduce} />
        ))}
      </div>
    </section>
  )
}

function PhotoColumn({
  src,
  alt,
  position,
  offset,
  drift,
  index,
  progress,
  reduce,
}: (typeof COLUMNS)[number] & { index: number; progress: MotionValue<number>; reduce: boolean }) {
  // Each column drifts at its own speed as the hero scrolls away.
  const y = useTransform(progress, [0, 1], [0, reduce ? 0 : drift])

  return (
    <motion.div style={{ y }} className={offset}>
      <motion.div
        className="relative h-full overflow-hidden rounded-[1.75rem] bg-muted"
        initial={{ clipPath: "inset(100% 0% 0% 0% round 1.75rem)" }}
        animate={{ clipPath: "inset(0% 0% 0% 0% round 1.75rem)" }}
        transition={{ duration: 1.2, ease: EASE_OUT, delay: 0.3 + index * 0.14 }}
      >
        <motion.div
          className="absolute inset-0"
          initial={{ scale: 1.25 }}
          animate={{ scale: 1 }}
          transition={{ duration: 1.6, ease: EASE_OUT, delay: 0.3 + index * 0.14 }}
        >
          <Image
            src={src}
            alt={alt}
            fill
            preload={index === 1}
            placeholder="blur"
            sizes="(min-width: 1024px) 15rem, 33vw"
            className="object-cover"
            style={{ objectPosition: position }}
          />
        </motion.div>
      </motion.div>
    </motion.div>
  )
}
