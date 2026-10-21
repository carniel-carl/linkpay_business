import type { Staff, StaffPermission, StaffRoleInfo } from "@/lib/api/types"

/** True when the staff member's role grants the permission. Never check role names. */
export const can = (staff: Pick<Staff, "permissions">, permission: StaffPermission) =>
  staff.permissions.includes(permission)

/** The role's label from GET /api/admin/staff/roles, or a readable fallback. */
export function roleLabel(role: string | undefined, roles?: StaffRoleInfo[]) {
  if (!role) return "No role"
  return roles?.find((r) => r.role === role)?.label ?? role.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase())
}
