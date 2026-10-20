import "server-only"
import { cookies } from "next/headers"
import type { AccountSetupStatus, Branch, Overview } from "@/lib/api/types"

/** The branch picked in the sidebar switcher. No cookie means "All branches". */
export const BRANCH_COOKIE = "lp_branch"

export async function getBranchCookie() {
  return (await cookies()).get(BRANCH_COOKIE)?.value ?? null
}

export async function setBranchCookie(branchId: string | null) {
  const jar = await cookies()
  if (!branchId) {
    jar.delete(BRANCH_COOKIE)
    return
  }
  jar.set(BRANCH_COOKIE, branchId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  })
}

/**
 * The selected branch, checked against the business's own branches. A stale cookie (a branch from
 * another account, or one that no longer exists) reads as "All branches".
 */
export async function getSelectedBranch(branches: Branch[]): Promise<Branch | null> {
  const id = await getBranchCookie()
  return (id && branches.find((b) => b._id === id)) || null
}

/**
 * The branch Home shows when nothing is selected: the head office, or for staff limited to other
 * branches, the first branch they can see.
 */
export function homeBranch(overview: Overview, selected: Branch | null): Branch | undefined {
  const branches = overview.branches ?? []
  return selected ?? branches.find((b) => b.isHeadOffice) ?? branches[0]
}

/** Account setup status for what's selected: that branch, or the home branch (the head office is mirrored on the business). */
export function setupStatusFor(overview: Overview, selected: Branch | null): AccountSetupStatus {
  return homeBranch(overview, selected)?.liquifia.accountStatus
    ?? overview.business.liquifia?.accountStatus
    ?? "not_started"
}
