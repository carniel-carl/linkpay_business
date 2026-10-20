import Image from "next/image"
import { ArrowLeftRight, Landmark, ReceiptText, Store, UsersRound, type LucideIcon } from "lucide-react"
import teamMeeting from "@/assets/landing/team-meeting.jpg"
import { cn } from "@/lib/utils"
import { Reveal } from "./reveal"
import { Spotlight } from "./spotlight"
import { VerificationPreview } from "./verification-preview"

function Tag({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn("w-fit rounded-[6px] px-2 py-0.5 text-xs font-medium", className)}>{children}</span>
}

function TileIcon({ icon: Icon, className }: { icon: LucideIcon; className?: string }) {
  return (
    <span className={cn("grid size-11 place-items-center rounded-[13px]", className)}>
      <Icon className="size-5" aria-hidden />
    </span>
  )
}

/** Five tiles: verification (live preview), the account, then the tools that follow it. */
export function Account() {
  return (
    <section id="account" className="mx-auto max-w-[1400px] scroll-mt-20 px-4 py-24 md:px-8 md:py-36">
      <Reveal className="grid max-w-3xl gap-5">
        <h2 className="type-display text-4xl text-balance md:text-6xl">The business side, in one account</h2>
        <p className="max-w-[48ch] text-lg leading-relaxed text-muted-foreground">
          Keep business money apart from personal money, with the tools to move it.
        </p>
      </Reveal>

      <div className="mt-14 grid gap-4 lg:grid-cols-6">
        <Reveal className="lg:col-span-3 lg:row-span-2">
          <Spotlight className="grid h-full content-between gap-10 bg-brand-subtle p-6 sm:p-9">
            <div className="grid gap-3">
              <h3 className="type-display text-3xl md:text-4xl">Verification you can follow</h3>
              <p className="max-w-[40ch] text-[15px] leading-relaxed text-muted-foreground">
                Every requirement is listed for your business type, and you see each one tick off.
              </p>
            </div>
            <VerificationPreview />
          </Spotlight>
        </Reveal>

        <Reveal className="lg:col-span-3" delay={0.08}>
          <Spotlight className="grid h-full min-h-[15rem] content-between gap-10 bg-primary p-6 text-primary-foreground sm:p-9">
            <div className="flex items-start justify-between gap-4">
              <TileIcon icon={Landmark} className="bg-primary-foreground/10" />
              <Tag className="bg-primary-foreground/10">Opens after verification</Tag>
            </div>
            <div className="grid gap-2">
              <h3 className="type-display text-3xl md:text-4xl">Naira current account</h3>
              <p className="max-w-[40ch] text-[15px] leading-relaxed opacity-75">
                In your registered business name, held with our partner bank.
              </p>
            </div>
          </Spotlight>
        </Reveal>

        <Reveal className="lg:col-span-3" delay={0.16}>
          <Spotlight className="surface grid h-full min-h-[15rem] content-between gap-10 p-6 sm:p-9">
            <div className="flex items-start justify-between gap-4">
              <TileIcon icon={ArrowLeftRight} className="bg-brand-subtle text-primary" />
              <Tag className="bg-muted text-muted-foreground">Coming soon</Tag>
            </div>
            <div className="grid gap-2">
              <h3 className="type-display text-3xl">Transfers</h3>
              <p className="max-w-[40ch] text-[15px] leading-relaxed text-muted-foreground">
                Pay suppliers and staff from the business account instead of a personal one.
              </p>
            </div>
          </Spotlight>
        </Reveal>

        <Reveal className="lg:col-span-2">
          <Spotlight className="grid h-full min-h-[18rem] content-between gap-10 bg-pop-subtle p-6 sm:p-9">
            <div className="flex items-start justify-between gap-4">
              <TileIcon icon={ReceiptText} className="bg-card text-foreground" />
              <Tag className="bg-card/70 text-foreground">Coming soon</Tag>
            </div>
            <div className="grid gap-2">
              <h3 className="type-display text-3xl">Invoices</h3>
              <p className="text-[15px] leading-relaxed text-foreground/75">
                Send invoices customers can pay straight into your account.
              </p>
            </div>
          </Spotlight>
        </Reveal>

        <Reveal className="lg:col-span-4" delay={0.08}>
          <Spotlight className="relative grid h-full min-h-[18rem] content-end bg-brand-surface p-6 sm:p-9">
            <Image
              src={teamMeeting}
              alt="A business team meeting around a table with laptops"
              fill
              placeholder="blur"
              sizes="(min-width: 1024px) 50rem, 100vw"
              className="-z-10 object-cover object-[50%_40%] transition-transform duration-[1.2s] ease-[cubic-bezier(0.16,1,0.3,1)] group-hover/spot:scale-[1.04]"
            />
            {/* Fixed dark scrim: the copy sits on a photo, so it must read the same in both themes. */}
            <div aria-hidden className="absolute inset-0 -z-10 bg-[linear-gradient(to_top,oklch(0.18_0.03_252/0.94),oklch(0.18_0.03_252/0.72)_45%,oklch(0.18_0.03_252/0.1)_90%)]" />
            <div className="grid gap-3 text-[oklch(0.98_0.005_250)]">
              <div className="flex gap-2">
                <TileIcon icon={Store} className="size-10 bg-white/12 backdrop-blur-md" />
                <TileIcon icon={UsersRound} className="size-10 bg-white/12 backdrop-blur-md" />
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <h3 className="type-display text-3xl md:text-4xl">Branches and team</h3>
                <Tag className="bg-white/15 backdrop-blur-md">Coming soon</Tag>
              </div>
              <p className="max-w-[48ch] text-[15px] leading-relaxed text-white/80">
                Give each shop its own view under one head office, and invite your accountant with access that fits.
              </p>
            </div>
          </Spotlight>
        </Reveal>
      </div>
    </section>
  )
}
