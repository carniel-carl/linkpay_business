"use client"

import { useEffect, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { ArrowRight } from "lucide-react"
import { openBusiness } from "@/app/(dashboard)/business-actions"
import { Spinner } from "@/components/ui/spinner"
import type { MembershipSummary } from "@/lib/api/types"
import { initials } from "@/lib/format"
import { roleLabel } from "@/lib/permissions"
import { membershipRestriction, RESTRICTION_LABELS } from "@/lib/restriction"
import { cn } from "@/lib/utils"

/** The closed page's way back into the user's other businesses. */
export function OtherBusinesses({ memberships }: { memberships: MembershipSummary[] }) {
  const [pending, startTransition] = useTransition()
  const [chosen, setChosen] = useState<string>()
  return (
    <ul className="grid gap-2" aria-busy={pending}>
      {memberships.map((m) => {
        const restriction = membershipRestriction(m)
        const label = RESTRICTION_LABELS[restriction]
        return (
          <li key={m.business._id}>
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                setChosen(m.business._id)
                startTransition(() => openBusiness(m.business._id))
              }}
              className="group flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors duration-150 outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60"
            >
              <span className="grid size-9 shrink-0 place-items-center rounded-[11px] bg-muted font-display text-xs font-bold">
                {initials(m.business.name)}
              </span>
              <span className="grid min-w-0 flex-1">
                <span className="truncate text-sm font-medium">{m.business.name}</span>
                <span className="truncate text-xs text-muted-foreground">{m.roleLabel ?? roleLabel(m.role)}</span>
              </span>
              {label && (
                <span
                  className={cn(
                    "shrink-0 rounded-[6px] px-1.5 py-0.5 text-[11px] leading-none font-medium",
                    restriction === "banned" ? "bg-destructive-subtle text-destructive" : "bg-warning-subtle text-warning-foreground",
                  )}
                >
                  {label}
                </span>
              )}
              {pending && chosen === m.business._id ? (
                <Spinner className="size-4" />
              ) : (
                <ArrowRight className="size-4 text-muted-foreground transition-transform duration-150 group-hover:translate-x-0.5" aria-hidden />
              )}
            </button>
          </li>
        )
      })}
    </ul>
  )
}

/** Checks again whenever the tab comes back into view, so a lifted ban opens the dashboard without a reload. */
export function RefreshWhenVisible() {
  const router = useRouter()
  useEffect(() => {
    const onVisible = () => document.visibilityState === "visible" && router.refresh()
    document.addEventListener("visibilitychange", onVisible)
    return () => document.removeEventListener("visibilitychange", onVisible)
  }, [router])
  return null
}
