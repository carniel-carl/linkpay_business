import type { Metadata } from "next"
import { NoAccess } from "@/components/common/no-access"
import { PageHeader } from "@/components/common/page-header"
import { InviteStaffDialog } from "@/components/staff/invite-dialog"
import { StaffInvitesList } from "@/components/staff/invites-list"
import { StaffList } from "@/components/staff/staff-list"
import { getStaff, getStaffInvites, getStaffList, getStaffRoles } from "@/lib/data"
import { can, roleLabel } from "@/lib/permissions"

export const metadata: Metadata = { title: "Staff" }

export default async function StaffPage() {
  const [me, roles] = await Promise.all([getStaff(), getStaffRoles()])
  const description = "Everyone who can sign in to the staff console. Each person's role decides what they can see and do."

  if (!can(me, "staff.manage")) {
    return (
      <>
        <PageHeader title="Staff" description={description} />
        <NoAccess title="Only super admins manage staff" roleLabel={roleLabel(me.role, roles)} />
      </>
    )
  }

  const [staff, invites] = await Promise.all([getStaffList(), getStaffInvites()])
  return (
    <>
      <PageHeader title="Staff" description={description} actions={<InviteStaffDialog roles={roles} />} />
      <div className="stagger grid gap-8">
        <div style={{ "--i": 0 } as React.CSSProperties}>
          <StaffList staff={staff} roles={roles} />
        </div>
        <div style={{ "--i": 1 } as React.CSSProperties}>
          <StaffInvitesList invites={invites} roles={roles} />
        </div>
      </div>
    </>
  )
}
