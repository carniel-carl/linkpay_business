import { NoAccess } from "@/components/common/no-access"
import { PageHeader } from "@/components/common/page-header"
import type { StaffPermission } from "@/lib/api/types"
import { getStaff, getStaffRoles } from "@/lib/data"
import { can, roleLabel } from "@/lib/permissions"

/**
 * For pages that need a permission: returns a "no access" page when the staff member's role lacks it,
 * or null to carry on. The backend refuses the data anyway; this replaces the error with an explanation.
 */
export async function requirePermission(permission: StaffPermission, title: string) {
  const staff = await getStaff()
  if (can(staff, permission)) return null
  const roles = await getStaffRoles()
  return (
    <>
      <PageHeader title={title} />
      <NoAccess title="Your role doesn't include this page" roleLabel={roleLabel(staff.role, roles)} />
    </>
  )
}
