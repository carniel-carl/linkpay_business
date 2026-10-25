import { ShieldAlert } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { SUPPORT_EMAIL } from "@/lib/support"

/**
 * Under the header on every dashboard page while the business is suspended (lib/restriction.ts). It says that the
 * business is restricted and what still works, never why: staff keep the reason.
 */
export function SuspendedBanner({ businessName }: { businessName: string }) {
  return (
    <section aria-label="Business suspended" className="border-t border-warning/30 bg-warning-subtle text-warning-foreground">
      <div className="flex items-start gap-2.5 px-4 py-2.5 text-sm md:px-8">
        <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
        <p className="text-pretty">
          <span className="font-medium">{businessName} is suspended.</span> You can view your account, but you can&apos;t send
          money or make changes. Contact{" "}
          <a href={`mailto:${SUPPORT_EMAIL}`} className="font-medium underline underline-offset-4 hover:no-underline">
            {SUPPORT_EMAIL}
          </a>
          .
        </p>
      </div>
    </section>
  )
}

/** In the header in place of "Verified" while suspended. Sits on the ink header. */
export function SuspendedBadge() {
  return (
    <Badge className="border-warning/40 bg-warning-subtle text-warning-foreground">
      <ShieldAlert data-icon="inline-start" aria-hidden />
      Suspended
    </Badge>
  )
}
