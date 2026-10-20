import type { Metadata } from "next"
import { UsersRound } from "lucide-react"
import { PageHeader } from "@/components/common/page-header"
import { FeaturePlaceholder } from "@/components/dashboard/feature-placeholder"
import { InviteDialog } from "@/components/team/invite-dialog"
import { InvitesList } from "@/components/team/invites-list"
import { LeaveBusiness } from "@/components/team/leave-business"
import { MembersList } from "@/components/team/members-list"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import type { Membership, Overview } from "@/lib/api/types"
import { getOverview, getTeam } from "@/lib/data"
import { can, grantableRoles, isOwner, roleLabel } from "@/lib/permissions"

export const metadata: Metadata = { title: "Team" }

export default async function TeamPage() {
  const overview = await getOverview()
  if (!overview || overview.business.status !== "approved" || !overview.membership) {
    return (
      <FeaturePlaceholder
        title="Team"
        icon={UsersRound}
        summary="Invite staff and control what they can do."
        detail="Invite your accountant and staff, and choose what each person can see, prepare or approve."
      />
    )
  }

  const { business, membership } = overview
  // Members who can't manage the team get their own access and nothing fetched.
  if (!can(overview, "team.manage")) return <NotAManager overview={overview} membership={membership} />

  const team = await getTeam()
  const branches = overview.branches.map((b) => ({ _id: b._id, name: b.name, isHeadOffice: b.isHeadOffice }))
  const grantable = grantableRoles(membership, team.roles.roles)

  return (
    <>
      <PageHeader
        title="Team"
        description="Invite your accountant and staff. Each person signs in with their own account, and their role decides what they can see and do."
        actions={
          <InviteDialog
            roles={grantable}
            catalog={team.roles.permissions}
            branches={branches}
            adminHidden={!isOwner(membership)}
          />
        }
      />
      <div className="stagger grid gap-8">
        <div style={{ "--i": 0 } as React.CSSProperties}>
          <MembersList
            members={team.members}
            actor={membership}
            roles={team.roles}
            branches={branches}
            businessName={business.name}
          />
        </div>
        <div style={{ "--i": 1 } as React.CSSProperties}>
          <InvitesList invites={team.invites} actor={membership} roles={team.roles.roles} />
        </div>
        {!isOwner(membership) && (
          <div style={{ "--i": 2 } as React.CSSProperties}>
            <LeaveBusiness businessName={business.name} />
          </div>
        )}
      </div>
    </>
  )
}

function NotAManager({ overview, membership }: { overview: Overview; membership: Membership }) {
  const { business } = overview
  // `branches` is null when the member sees every branch; the overview already holds only their branches.
  const branchNames = membership.branches === null ? "all branches" : overview.branches.map((b) => b.name).join(", ")

  return (
    <>
      <PageHeader title="Team" description={`The people who work on ${business.name} in LinkPay.`} />
      <div className="grid gap-8">
        <Empty className="surface min-h-80 border-0 p-10">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <UsersRound aria-hidden />
            </EmptyMedia>
            <EmptyTitle>Ask an owner or admin to manage the team</EmptyTitle>
            <EmptyDescription>
              Your role is {roleLabel(membership.role)}, with access to {branchNames}. The business owner or an admin
              can invite people and change what they can do.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
        <LeaveBusiness businessName={business.name} />
      </div>
    </>
  )
}
