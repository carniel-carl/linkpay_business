import type { Metadata } from "next"
import { Building2, Hourglass, MapPin, Pencil, Plus, Store, UserRound } from "lucide-react"
import { CopyButton } from "@/components/accounts/copy-button"
import { RefreshWhileSettingUp, ViewBranchButton } from "@/components/branches/branch-actions"
import { BranchFormDialog } from "@/components/branches/branch-form-dialog"
import { PageHeader } from "@/components/common/page-header"
import { FeaturePlaceholder } from "@/components/dashboard/feature-placeholder"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { Branch } from "@/lib/api/types"
import { getBranches, getOverview, getSelected } from "@/lib/data"
import { can } from "@/lib/permissions"
import { cn } from "@/lib/utils"

export const metadata: Metadata = { title: "Branches" }

export default async function BranchesPage() {
  const overview = await getOverview()
  if (!overview || overview.business.status !== "approved") {
    return (
      <FeaturePlaceholder
        title="Branches"
        icon={Store}
        summary="Separate account numbers for each location."
        detail="Give each shop, warehouse or office its own account number and see what each location brings in."
      />
    )
  }

  const [branches, selected] = await Promise.all([getBranches(), getSelected()])
  const settingUp = branches.some((b) => !b.account)
  const canManage = can(overview, "branches.manage")

  return (
    <>
      <PageHeader
        title="Branches"
        description={
          canManage
            ? "Each shop, warehouse or office gets its own account number, so you can see what each location brings in."
            : "The locations you work with and their account numbers. The owner or an admin adds and edits branches."
        }
        actions={
          canManage && (
            <BranchFormDialog>
              <Button>
                <Plus data-icon="inline-start" aria-hidden />
                Add branch
              </Button>
            </BranchFormDialog>
          )
        }
      />
      <RefreshWhileSettingUp active={settingUp} />
      <ul className="stagger grid gap-6 lg:grid-cols-2">
        {branches.map((branch, i) => (
          <li key={branch._id} style={{ "--i": i } as React.CSSProperties}>
            <BranchCard branch={branch} viewing={selected?._id === branch._id} canEdit={canManage} />
          </li>
        ))}
      </ul>
    </>
  )
}

function BranchCard({ branch, viewing, canEdit }: { branch: Branch; viewing: boolean; canEdit: boolean }) {
  const Icon = branch.isHeadOffice ? Building2 : Store
  const address = [branch.address?.street, branch.address?.city, branch.address?.state].filter(Boolean).join(", ")
  const manager = branch.manager?.name
  const managerContact = [branch.manager?.email, branch.manager?.phone].filter(Boolean).join(" · ")

  return (
    <article
      aria-labelledby={`branch-${branch._id}`}
      className={cn("surface grid h-full content-between gap-7 p-6 sm:p-7", viewing && "ring-2 ring-primary/40")}
    >
      <div className="grid gap-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3.5">
            <span className="grid size-11 shrink-0 place-items-center rounded-[13px] bg-brand-subtle text-primary">
              <Icon className="size-5" aria-hidden />
            </span>
            <div className="grid min-w-0 gap-1">
              <h2 id={`branch-${branch._id}`} className="truncate font-display text-xl font-semibold tracking-[-0.02em]">
                {branch.name}
              </h2>
              <div className="flex flex-wrap gap-1.5">
                {branch.isHeadOffice && <Badge variant="muted">Head office</Badge>}
                {viewing && <Badge variant="outline">Viewing now</Badge>}
              </div>
            </div>
          </div>
          {canEdit && (
            <BranchFormDialog branch={branch}>
              <Button variant="ghost" size="icon-sm" aria-label={`Edit ${branch.name}`}>
                <Pencil aria-hidden />
              </Button>
            </BranchFormDialog>
          )}
        </div>

        <AccountBlock branch={branch} />

        <dl className="grid gap-3 text-sm">
          <div className="flex items-start gap-2.5">
            <dt className="sr-only">Address</dt>
            <MapPin className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            <dd className={cn(!address && "text-muted-foreground")}>{address || "No address added"}</dd>
          </div>
          <div className="flex items-start gap-2.5">
            <dt className="sr-only">Manager</dt>
            <UserRound className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            <dd className="grid gap-0.5">
              <span className={cn(!manager && "text-muted-foreground")}>{manager || "No manager added"}</span>
              {managerContact && <span className="text-xs text-muted-foreground">{managerContact}</span>}
            </dd>
          </div>
        </dl>
      </div>

      {!viewing && branch.account && (
        <div className="-mb-2 -ml-3 flex">
          <ViewBranchButton branchId={branch._id} name={branch.name} />
        </div>
      )}
    </article>
  )
}

/** The branch's account number, or a calm "setting up" note. Owners never see a failed setup. */
function AccountBlock({ branch }: { branch: Branch }) {
  const { account } = branch
  if (!account) {
    return (
      <div className="flex items-center gap-3 rounded-xl bg-muted/70 px-4 py-3.5 text-sm" aria-live="polite">
        <Hourglass className="size-4 shrink-0 text-primary" aria-hidden />
        <span className="text-muted-foreground">Setting up this branch&apos;s account. The number appears here when it&apos;s ready.</span>
      </div>
    )
  }
  return (
    <div className="grid gap-1 rounded-xl bg-muted/70 px-4 py-3.5">
      <span className="text-xs text-muted-foreground">
        {account.bankName ?? "Partner bank"}
        {account.accountName && `, ${account.accountName}`}
      </span>
      <span className="flex items-center gap-1">
        <span className="font-mono text-xl tracking-[0.04em]">{account.accountNumber}</span>
        <CopyButton value={account.accountNumber} message="Account number copied" label={`Copy ${branch.name} account number`} />
      </span>
    </div>
  )
}
