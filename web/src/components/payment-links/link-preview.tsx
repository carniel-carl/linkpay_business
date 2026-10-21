"use client"

import { FundraiserProgress, QuickPicks } from "@/components/pay/donation-parts"
import { brandVars, LinkSummary, Secured, StepTrack, type SummaryImage } from "@/components/pay/pay-parts"
import type { BrandPalette, PhoneFieldMode } from "@/lib/api/types"
import { formatNaira } from "@/lib/format"

export type PreviewProps = {
  business: { name: string; logoSrc: string | null; palette: BrandPalette }
  title: string
  description: string
  /** Pictures in order; the first is the cover. */
  images: SummaryImage[]
  /** A fixed price (`amountKobo` is null until a valid amount is typed), or the customer chooses. */
  fixed: boolean
  amountKobo: number | null
  minAmountKobo: number | null
  phone: PhoneFieldMode
  questions: { label: string; required: boolean }[]
  /** A donation link: its goal and quick picks, shown as the fundraiser page draws them (nothing raised yet). */
  donation?: { goalKobo: number | null; suggestedAmountsKobo: number[] } | null
}

/**
 * The link's page as a customer sees it on a phone, drawn from the form as it's filled in. The top is the
 * pay page's own `LinkSummary` (components/pay/pay-parts.tsx), so it matches; the sheet below is a sketch.
 */
export function LinkPreview({ business, title, description, images, fixed, amountKobo, minAmountKobo, phone, questions, donation }: PreviewProps) {
  const price = fixed ? (amountKobo ?? 0) : null
  return (
    <div style={brandVars(business.palette)} className="pay-brand overflow-hidden rounded-[18px] bg-background shadow-surface">
      <div className="grain bg-(--biz) px-6 pt-7 pb-24 text-(--on-biz) sm:px-8">
        <LinkSummary
          businessName={business.name}
          logoSrc={business.logoSrc}
          title={title.trim() || "Your link's title"}
          description={description.trim() || null}
          amountKobo={price}
          minAmountKobo={fixed ? null : minAmountKobo}
          images={images}
          variant="panel"
          price={
            donation && (
              <FundraiserProgress
                progress={{ goalKobo: donation.goalKobo, raisedKobo: 0, donationsCount: 0, percent: donation.goalKobo ? 0 : null, lastDonationAt: null }}
              />
            )
          }
        />
      </div>
      <div className="relative z-10 -mt-16 grid gap-4 px-4 pb-6 sm:px-6" aria-hidden>
        <div className="surface grid gap-5 p-6">
          <StepTrack step={0} />
          <div className="grid gap-4">
            {donation && donation.suggestedAmountsKobo.length > 0 && <QuickPicks amounts={donation.suggestedAmountsKobo} selectedKobo={null} onPick={() => {}} />}
            {!fixed && <FakeField label="Amount" hint={minAmountKobo ? `At least ${formatNaira(minAmountKobo)}` : undefined} value="₦" />}
            <FakeField label="Your name" />
            <FakeField label="Email" />
            {phone !== "off" && <FakeField label={phone === "optional" ? "Phone (optional)" : "Phone"} />}
            {questions
              .filter((q) => q.label.trim())
              .map((q, i) => (
                <FakeField key={i} label={q.required ? q.label.trim() : `${q.label.trim()} (optional)`} />
              ))}
          </div>
          <span className="grid h-11 place-items-center rounded-full bg-(--biz) text-sm font-medium text-(--on-biz)">
            {donation ? "Donate by bank transfer" : fixed ? `Pay ${formatNaira(price ?? 0)}` : "Continue to pay"}
          </span>
        </div>
        <Secured businessName={business.name} className="text-center text-muted-foreground" />
      </div>
    </div>
  )
}

function FakeField({ label, hint, value }: { label: string; hint?: string; value?: string }) {
  return (
    <div className="grid gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      <span className="flex h-10 items-center rounded-[10px] border bg-background px-3 text-sm text-muted-foreground">{value}</span>
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  )
}
