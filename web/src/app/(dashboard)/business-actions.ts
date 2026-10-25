"use server"

import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"
import { setBusinessCookie } from "@/lib/business-context"
import { getMemberships } from "@/lib/data"
import { CLOSED_PATH, membershipRestriction } from "@/lib/restriction"

/** Business switcher: works in another business the user belongs to, from its "All branches" view. */
export async function selectBusiness(businessId: string) {
  const memberships = await getMemberships()
  const target = memberships.find((m) => m.business._id === businessId)
  if (!target) return
  await setBusinessCookie(businessId)
  // A closed business has no dashboard, only its closed page.
  if (membershipRestriction(target) === "banned") redirect(CLOSED_PATH)
  revalidatePath("/", "layout")
}

/** From the closed page: opens another business's dashboard (or its own closed page, if that one is closed too). */
export async function openBusiness(businessId: string) {
  const memberships = await getMemberships()
  const target = memberships.find((m) => m.business._id === businessId)
  if (!target) return
  await setBusinessCookie(businessId)
  redirect(membershipRestriction(target) === "banned" ? CLOSED_PATH : "/dashboard")
}

/** Drops a business choice the backend no longer accepts (see ClearStaleBusiness). */
export async function clearStaleBusiness() {
  await setBusinessCookie(null)
}
