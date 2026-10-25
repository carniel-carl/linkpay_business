// Compliance restrictions on a business (docs/briefs/compliance.md §6). The business is told that it's restricted,
// never why. Suspended: every read works and every change is refused (BUSINESS_SUSPENDED), so the dashboard shows a
// banner and disables its main write actions. Banned, shown as "Closed": every business route is refused
// (BUSINESS_BANNED), so the dashboard is replaced by /closed.
import type { MembershipSummary, Overview, RestrictionStatus } from "@/lib/api/types"

export const CLOSED_PATH = "/closed"

export const restrictionOf = (overview: Pick<Overview, "business"> | null | undefined): RestrictionStatus =>
  overview?.business.restriction?.status ?? "active"

export const isSuspended = (overview: Pick<Overview, "business"> | null | undefined) => restrictionOf(overview) === "suspended"

export const isClosed = (overview: Pick<Overview, "business"> | null | undefined) => restrictionOf(overview) === "banned"

/** GET /api/memberships carries the status alone. */
export const membershipRestriction = (m: MembershipSummary): RestrictionStatus => m.business.restriction ?? "active"

/** How the switcher and other lists name a restriction. Nothing for an active business. */
export const RESTRICTION_LABELS: Record<RestrictionStatus, string | null> = {
  active: null,
  suspended: "Suspended",
  banned: "Closed",
}

/** Why a write action is disabled (tooltip and screen-reader text). */
export const suspendedHint = (businessName: string) => `${businessName} is suspended, so you can't do this right now.`
