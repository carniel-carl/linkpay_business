// What the signed-in member may do. Decide from `membership.permissions`, never from the role name.
// The one exception mirrors the backend's rule that only the owner manages admins (controllers/team.ts).
import type { Membership, Overview, Permission, RoleInfo, RolesResponse, TeamRole } from "@/lib/api/types"

export function can(overview: Pick<Overview, "membership"> | null | undefined, permission: Permission) {
  return !!overview?.membership?.permissions.includes(permission)
}

export const isOwner = (membership?: Pick<Membership, "role"> | null) => membership?.role === "owner"

/** The label from GET /api/team/roles when we have it; otherwise the role name, capitalised. */
export function roleLabel(role: TeamRole, roles?: RoleInfo[]) {
  return roles?.find((r) => r.role === role)?.label ?? role.charAt(0).toUpperCase() + role.slice(1)
}

/**
 * Whether the actor can change or remove this member (or resend and revoke an invite for this role).
 * Nobody changes the owner or themselves; only the owner touches admins.
 */
export function canManage(actor: Pick<Membership, "role">, target: { role: TeamRole; isYou?: boolean }) {
  if (target.role === "owner" || target.isYou) return false
  return target.role !== "admin" || isOwner(actor)
}

/** Roles the actor can hand out: assignable ones, and admin only for the owner. */
export function grantableRoles(actor: Pick<Membership, "role">, roles: RoleInfo[]) {
  return roles.filter((r) => r.assignable && (r.role !== "admin" || isOwner(actor)))
}

/** "See account numbers and balances, prepare transfers, and create and send invoices." */
export function describeRole(role: RoleInfo, catalog: RolesResponse["permissions"]) {
  const labels = role.permissions.map((key) => catalog.find((p) => p.key === key)?.label ?? key)
  if (role.businessWide && role.permissions.includes("team.manage")) return "Everything, including managing the team and branches."
  if (labels.length === 0) return "No access yet."
  const lower = labels.map((l, i) => (i === 0 ? l : l.charAt(0).toLowerCase() + l.slice(1)))
  // Always a comma before the last "and": labels contain "and" themselves ("numbers and balances").
  const sentence = lower.length === 1 ? lower[0] : `${lower.slice(0, -1).join(", ")}, and ${lower.at(-1)}`
  return `${sentence}.`
}
