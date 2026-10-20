"use server"

import { revalidatePath } from "next/cache"
import { setBusinessCookie } from "@/lib/business-context"
import { getMemberships } from "@/lib/data"

/** Business switcher: works in another business the user belongs to, from its "All branches" view. */
export async function selectBusiness(businessId: string) {
  const memberships = await getMemberships()
  if (!memberships.some((m) => m.business._id === businessId)) return
  await setBusinessCookie(businessId)
  revalidatePath("/", "layout")
}

/** Drops a business choice the backend no longer accepts (see ClearStaleBusiness). */
export async function clearStaleBusiness() {
  await setBusinessCookie(null)
}
