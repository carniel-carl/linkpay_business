"use client"

import { useRef } from "react"
import Link from "next/link"
import { motion, useMotionValueEvent, useScroll } from "motion/react"
import { Logo } from "@/components/brand/logo"
import { Button } from "@/components/ui/button"
import { EASE_OUT } from "./motion"

const LINKS = [
  { href: "#how-it-works", label: "How it works" },
  { href: "#businesses", label: "Who it's for" },
  { href: "#account", label: "Account" },
  { href: "#faq", label: "Questions" },
]

// Static links on purpose: signed-in visitors who press Sign in are sent on to /dashboard by the proxy.
// Past the top of the page the bar condenses into a glass pill (a data attribute, so no re-render).
export function SiteHeader() {
  const ref = useRef<HTMLDivElement>(null)
  const { scrollY } = useScroll()

  useMotionValueEvent(scrollY, "change", (y) => {
    if (ref.current) ref.current.dataset.scrolled = String(y > 24)
  })

  return (
    <motion.header
      initial={{ y: -24, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.8, ease: EASE_OUT, delay: 0.1 }}
      className="fixed inset-x-0 top-0 z-header px-2 pt-3 md:px-4"
    >
      <div
        ref={ref}
        data-scrolled="false"
        className="group mx-auto flex h-14 max-w-[calc(1400px-2rem)] items-center justify-between gap-6 rounded-full border border-transparent px-2 transition-[max-width,padding,background-color,border-color,box-shadow] duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] data-[scrolled=true]:max-w-4xl data-[scrolled=true]:px-3 md:px-4 md:data-[scrolled=true]:px-3 data-[scrolled=true]:border-foreground/10 data-[scrolled=true]:bg-card/70 data-[scrolled=true]:shadow-[0_12px_40px_-12px_oklch(0.1_0.03_252/0.6),inset_0_1px_0_oklch(1_0_0/0.06)] data-[scrolled=true]:backdrop-blur-xl"
      >
        <Link
          href="/"
          aria-label="LinkPay Business home"
          className="rounded-lg focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <Logo showProduct={false} className="sm:hidden" />
          <Logo className="hidden sm:inline-flex" />
        </Link>
        <nav aria-label="Main" className="hidden items-center gap-0.5 lg:flex">
          {LINKS.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className="rounded-full px-3.5 py-2 text-sm text-muted-foreground transition-colors duration-200 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              {l.label}
            </a>
          ))}
        </nav>
        <div className="flex items-center gap-1.5">
          <Button variant="ghost" size="sm" className="rounded-full hover:bg-foreground/10" asChild>
            <Link href="/sign-in">Sign in</Link>
          </Button>
          <Button size="sm" asChild>
            <Link href="/sign-up">Open an account</Link>
          </Button>
        </div>
      </div>
    </motion.header>
  )
}
