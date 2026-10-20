"use client"

import { useLayoutEffect, useRef, useState } from "react"
import Image, { type StaticImageData } from "next/image"
import { BadgeCheck, FileCheck2, UserRoundPlus, type LucideIcon } from "lucide-react"
import { motion, useScroll, useSpring, useTransform } from "motion/react"
import directorLaptop from "@/assets/landing/director-laptop.jpg"
import founderDesk from "@/assets/landing/founder-desk.jpg"
import teamReview from "@/assets/landing/team-review.jpg"
import { useMediaQuery, usePrefersReducedMotion } from "./use-media-query"

type Step = { icon: LucideIcon; title: string; body: string; detail: string; image: StaticImageData; alt: string; position: string }

const STEPS: Step[] = [
  {
    icon: UserRoundPlus,
    title: "Sign up",
    body: "Create your login with an email address and a one-time code.",
    detail: "No branch visit. No forms to print.",
    image: founderDesk,
    alt: "A business owner smiling at her desk with a laptop",
    position: "45% 40%",
  },
  {
    icon: FileCheck2,
    title: "Verify",
    body: "Add your CAC details, owners and directors, then upload the documents your business type needs.",
    detail: "We list exactly what to upload.",
    image: directorLaptop,
    alt: "A company director in an olive suit working on his laptop",
    position: "30% 50%",
  },
  {
    icon: BadgeCheck,
    title: "Bank",
    body: "A person reviews every submission, usually within 1 to 2 business days. Once approved, your account opens.",
    detail: "We email you the outcome.",
    image: teamReview,
    alt: "Three colleagues around a laptop, one pointing at the screen",
    position: "60% 35%",
  },
]

const INTRO = {
  title: "Three steps to a verified business account",
  body: "Everything happens online. Save as you go and come back when your documents are ready.",
}

/**
 * Desktop: the section pins and the steps pan sideways as you scroll down (scroll length = track
 * overflow). Mobile and reduced motion: a plain vertical stack.
 */
export function HowItWorks() {
  const reduce = usePrefersReducedMotion()
  const wide = useMediaQuery("(min-width: 1024px)")
  return (
    <section id="how-it-works" aria-labelledby="how-title" className="scroll-mt-20">
      {wide && !reduce ? <Pan /> : <Stack />}
    </section>
  )
}

function Pan() {
  const wrap = useRef<HTMLDivElement>(null)
  const track = useRef<HTMLDivElement>(null)
  const [distance, setDistance] = useState(0)

  // Measured on mount and resize only, never per frame.
  useLayoutEffect(() => {
    const measure = () => {
      if (track.current) setDistance(Math.max(0, track.current.scrollWidth - window.innerWidth))
    }
    measure()
    const ro = new ResizeObserver(measure)
    if (track.current) ro.observe(track.current)
    window.addEventListener("resize", measure)
    return () => {
      ro.disconnect()
      window.removeEventListener("resize", measure)
    }
  }, [])

  const { scrollYProgress } = useScroll({ target: wrap, offset: ["start start", "end end"] })
  const x = useTransform(scrollYProgress, [0, 1], [0, -distance])
  const smoothX = useSpring(x, { stiffness: 140, damping: 30, mass: 0.4 })
  const bar = useTransform(scrollYProgress, [0, 1], [0, 1])

  return (
    <div ref={wrap} style={{ height: `calc(100dvh + ${distance}px)` }} className="relative">
      <div className="sticky top-0 flex h-dvh flex-col justify-center overflow-hidden">
        <motion.div ref={track} style={{ x: smoothX }} className="flex w-max items-stretch gap-6 pr-[8vw] pl-[max(2rem,calc((100vw-1400px)/2+2rem))]">
          <div className="flex w-[30rem] shrink-0 flex-col justify-center gap-6 pr-10">
            <p className="text-xs font-medium tracking-[0.16em] text-muted-foreground uppercase">How it works</p>
            <h2 id="how-title" className="type-display text-6xl text-balance">
              {INTRO.title}
            </h2>
            <p className="max-w-[36ch] text-lg leading-relaxed text-muted-foreground">{INTRO.body}</p>
          </div>
          {STEPS.map((step) => (
            <StepPanel key={step.title} step={step} />
          ))}
        </motion.div>
        <div className="mx-auto mt-10 w-full max-w-[1400px] px-8">
          <motion.div style={{ scaleX: bar }} className="h-0.5 origin-left rounded-full bg-primary" />
        </div>
      </div>
    </div>
  )
}

function StepPanel({ step }: { step: Step }) {
  const Icon = step.icon
  return (
    <article className="surface grid h-[min(68dvh,36rem)] w-[min(72vw,62rem)] shrink-0 grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] overflow-hidden rounded-[2rem]!">
      <div className="relative">
        <Image
          src={step.image}
          alt={step.alt}
          fill
          placeholder="blur"
          sizes="36rem"
          className="object-cover"
          style={{ objectPosition: step.position }}
        />
      </div>
      <div className="flex flex-col justify-between gap-8 p-10 xl:p-12">
        <span className="grid size-12 place-items-center rounded-[14px] bg-brand-subtle text-primary">
          <Icon className="size-5" aria-hidden />
        </span>
        <div className="grid gap-5">
          <h3 className="type-display text-[clamp(3.5rem,5.5vw,5.5rem)]">{step.title}</h3>
          <p className="max-w-[34ch] text-lg leading-relaxed text-muted-foreground">{step.body}</p>
          <p className="w-fit rounded-full bg-pop-subtle px-3.5 py-1.5 text-sm font-medium text-foreground">{step.detail}</p>
        </div>
      </div>
    </article>
  )
}

function Stack() {
  return (
    <div className="mx-auto grid max-w-[1400px] gap-10 px-4 py-20 md:px-8">
      <div className="grid gap-4">
        <p className="text-xs font-medium tracking-[0.16em] text-muted-foreground uppercase">How it works</p>
        <h2 id="how-title" className="type-display text-4xl text-balance md:text-5xl">
          {INTRO.title}
        </h2>
        <p className="max-w-[44ch] text-[17px] leading-relaxed text-muted-foreground">{INTRO.body}</p>
      </div>
      <ol className="grid gap-6 md:grid-cols-3">
        {STEPS.map((step) => (
          <li key={step.title} className="surface overflow-hidden rounded-[1.75rem]!">
            <div className="relative aspect-[4/3]">
              <Image
                src={step.image}
                alt={step.alt}
                fill
                placeholder="blur"
                sizes="(min-width: 768px) 33vw, 100vw"
                className="object-cover"
                style={{ objectPosition: step.position }}
              />
            </div>
            <div className="grid gap-3 p-6">
              <h3 className="type-display text-4xl">{step.title}</h3>
              <p className="text-[15px] leading-relaxed text-muted-foreground">{step.body}</p>
              <p className="w-fit rounded-full bg-pop-subtle px-3 py-1 text-sm font-medium text-foreground">{step.detail}</p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}
