import type { Metadata } from "next"
import { Account } from "@/components/landing/account"
import { Businesses } from "@/components/landing/businesses"
import { Closing } from "@/components/landing/closing"
import { Faq } from "@/components/landing/faq"
import { Hero } from "@/components/landing/hero"
import { HowItWorks } from "@/components/landing/how-it-works"
import { LandingMotion } from "@/components/landing/landing-motion"
import { Security } from "@/components/landing/security"
import { SiteFooter } from "@/components/landing/site-footer"
import { SiteHeader } from "@/components/landing/site-header"
import { Statement } from "@/components/landing/statement"

// Photos: Pexels (free licence), self-hosted in src/assets/landing.

export const metadata: Metadata = {
  title: { absolute: "LinkPay Business · Business banking for Nigerian businesses" },
  description:
    "A naira business account for companies registered in Nigeria. Verify once with your CAC documents, then run payments, invoices and branches from one account.",
}

export default function LandingPage() {
  return (
    <LandingMotion>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-full focus:bg-pop focus:px-4 focus:py-2 focus:text-pop-foreground"
      >
        Skip to content
      </a>
      <SiteHeader />
      <main id="main" className="overflow-x-clip">
        <Hero />
        <Statement />
        <HowItWorks />
        <Businesses />
        <Account />
        <Security />
        <Faq />
        <Closing />
      </main>
      <SiteFooter />
    </LandingMotion>
  )
}
