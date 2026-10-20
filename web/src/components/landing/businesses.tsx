"use client"

import { useRef } from "react"
import Image from "next/image"
import Link from "next/link"
import { ArrowUpRight } from "lucide-react"
import { motion, useScroll, useTransform } from "motion/react"
import market from "@/assets/landing/market.jpg"
import { BUSINESS_TYPE_INFO, type BusinessType } from "@/lib/kyb"
import { EASE_OUT } from "./motion"
import { usePrefersReducedMotion } from "./use-media-query"

const TYPES = Object.entries(BUSINESS_TYPE_INFO) as [BusinessType, { label: string; hint: string }][]

export function Businesses() {
  const ref = useRef<HTMLElement>(null)
  const reduce = usePrefersReducedMotion()
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start end", "end start"] })
  // The photo eases from a close crop to the full frame while the list scrolls past.
  const scale = useTransform(scrollYProgress, [0, 1], reduce ? [1, 1] : [1.3, 1])

  return (
    <section
      ref={ref}
      id="businesses"
      className="mx-auto grid max-w-[1400px] scroll-mt-20 gap-12 px-4 py-24 md:px-8 md:py-36 lg:grid-cols-12 lg:gap-8"
    >
      <div className="lg:col-span-5">
        <div className="grid gap-8 lg:sticky lg:top-24">
          <h2 className="type-display text-4xl text-balance md:text-6xl">Every kind of registered business</h2>
          <div className="relative aspect-[4/3] overflow-hidden rounded-[1.75rem] lg:aspect-[4/5] lg:max-h-[calc(100dvh-16rem)]">
            <motion.div style={{ scale }} className="absolute inset-0">
              <Image
                src={market}
                alt="Traders at a busy open-air market, one selling sliced watermelon from a wheelbarrow"
                fill
                placeholder="blur"
                sizes="(min-width: 1024px) 34rem, 100vw"
                className="object-cover object-[50%_62%]"
              />
            </motion.div>
          </div>
        </div>
      </div>

      <div className="grid content-start lg:col-span-6 lg:col-start-7">
        <p className="max-w-[44ch] pb-10 text-lg leading-relaxed text-muted-foreground">
          From a one-person business name to an incorporated trust. If it&apos;s registered with CAC, it can have an
          account.
        </p>
        <ul className="grid border-t">
          {TYPES.map(([key, { label, hint }], i) => (
            <motion.li
              key={key}
              className="border-b"
              initial={{ opacity: 0, y: 24 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.6 }}
              transition={{ duration: 0.8, ease: EASE_OUT, delay: i * 0.05 }}
            >
              <Link
                href="/sign-up"
                className="group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-6 py-7 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none md:py-9"
              >
                <span className="grid gap-2 transition-transform duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:translate-x-3">
                  <span className="type-display text-[clamp(1.75rem,3vw,2.75rem)]">{label}</span>
                  <span className="max-w-[46ch] text-[15px] leading-relaxed text-muted-foreground">{hint}</span>
                </span>
                <span className="grid size-12 place-items-center rounded-full border transition-[background-color,border-color,color,transform] duration-300 group-hover:rotate-45 group-hover:border-transparent group-hover:bg-pop group-hover:text-pop-foreground">
                  <ArrowUpRight className="size-5" aria-hidden />
                  <span className="sr-only">Open an account as a {label.toLowerCase()}</span>
                </span>
              </Link>
            </motion.li>
          ))}
        </ul>
      </div>
    </section>
  )
}
