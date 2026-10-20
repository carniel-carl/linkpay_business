import "server-only"
import { redirect } from "next/navigation"
import { getOverview } from "@/lib/data"
import { EDITABLE } from "@/lib/onboarding"

/** For wizard steps 2 to 5: the business must exist and still be editable. */
export async function requireEditableOverview() {
  const overview = await getOverview()
  if (!overview) redirect("/onboarding")
  if (overview.business.status === "approved") redirect("/dashboard")
  if (!EDITABLE.includes(overview.business.status)) redirect("/onboarding/status")
  return overview
}
