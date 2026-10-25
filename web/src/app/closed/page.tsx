import type { Metadata } from "next"
import { redirect } from "next/navigation"
import { LogOut, Mail } from "lucide-react"
import { signOut } from "@/app/(auth)/actions"
import { AuthFrame } from "@/components/auth/auth-frame"
import type { Ledger } from "@/components/auth/ledgers"
import { OtherBusinesses, RefreshWhenVisible } from "@/components/shell/closed-business"
import { Button } from "@/components/ui/button"
import { getMemberships, getOverview } from "@/lib/data"
import { isClosed } from "@/lib/restriction"
import { SUPPORT_EMAIL } from "@/lib/support"

export const metadata: Metadata = { title: "Business closed" }

// What closing does today (docs/briefs/compliance.md §1). Never why: the business isn't told the reason.
const CLOSED_LEDGER: Ledger = {
  label: "What closing means",
  rows: [
    { key: "money", title: "Sending money", detail: "Nothing can be sent from the business's accounts" },
    { key: "waiting", title: "Waiting transfers", detail: "Transfers that were waiting for approval were cancelled" },
    { key: "team", title: "Team invites", detail: "Open invites to join the business no longer work" },
    { key: "balance", title: "Money in the account", detail: "Contact support about any money left in it" },
    { key: "sign-in", title: "Your sign-in", detail: "Still works for any other business you belong to" },
  ],
}

/**
 * In place of the dashboard for a business compliance has closed (banned): every business route refuses it, so
 * there is nothing to show. The dashboard layout and its reads send members here; a business that isn't closed
 * (the ban was lifted, or the member switched) goes back to the dashboard.
 */
export default async function ClosedBusinessPage() {
  const [overview, memberships] = await Promise.all([getOverview(), getMemberships()])
  if (!overview) redirect("/onboarding")
  if (!isClosed(overview)) redirect("/dashboard")

  const { name } = overview.business
  const others = memberships.filter((m) => m.business._id !== overview.business._id)

  return (
    <AuthFrame
      title="This business has been closed"
      description={
        <>
          <strong>{name}</strong> can no longer use LinkPay Business, so its accounts, payments and team aren&apos;t
          available here. Contact support about it, including any money left in the account.
        </>
      }
      sheetTitle="What you can do"
      ledger={CLOSED_LEDGER}
    >
      <RefreshWhenVisible />
      <div className="grid gap-7">
        <section aria-labelledby="closed-support" className="grid gap-3">
          <h3 id="closed-support" className="text-sm font-medium">
            Contact support
          </h3>
          <Button size="lg" className="w-full" asChild>
            <a href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(`Closed business: ${name}`)}`}>
              <Mail data-icon="inline-start" aria-hidden />
              Email support
            </a>
          </Button>
          <p className="text-sm break-words text-muted-foreground">
            Our address is <span className="font-medium text-foreground select-all">{SUPPORT_EMAIL}</span>.
          </p>
        </section>

        {others.length > 0 && (
          <section aria-labelledby="closed-others" className="grid gap-3">
            <h3 id="closed-others" className="text-sm font-medium">
              Your other {others.length === 1 ? "business" : "businesses"}
            </h3>
            <OtherBusinesses memberships={others} />
          </section>
        )}

        <form action={signOut} className="border-t pt-5">
          <Button type="submit" variant="outline" className="w-full">
            <LogOut data-icon="inline-start" aria-hidden />
            Sign out
          </Button>
        </form>
      </div>
    </AuthFrame>
  )
}
