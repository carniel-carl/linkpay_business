import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { CircleCheck, MessageSquareText, TriangleAlert } from "lucide-react"
import { AdminSection } from "@/components/admin/admin-section"
import { BankAccountPanel } from "@/components/admin/bank-account-panel"
import { BranchesPanel } from "@/components/admin/branches-panel"
import { DocumentViewer, type ViewerDocument } from "@/components/admin/document-viewer"
import { ReviewActions } from "@/components/admin/review-actions"
import { BusinessSummary } from "@/components/business/business-summary"
import { BusinessHeader } from "@/components/admin/business-header"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { Overview } from "@/lib/api/types"
import { getAdminBusiness, getStaff } from "@/lib/data"
import { requirePermission } from "@/lib/guard"
import { can } from "@/lib/permissions"
import { formatDateTime, maskBVN } from "@/lib/format"
import { DOCUMENT_TYPES, ID_TYPE_LABELS, ROLE_LABELS } from "@/lib/kyb"
import { cn } from "@/lib/utils"

export async function generateMetadata({ params }: PageProps<"/businesses/[id]">): Promise<Metadata> {
  if (!can(await getStaff(), "businesses.view")) return { title: "Business" }
  const overview = await getAdminBusiness((await params).id)
  return { title: overview?.business.name ?? "Business not found" }
}

export default async function AdminBusinessPage({ params }: PageProps<"/businesses/[id]">) {
  const blocked = await requirePermission("businesses.view", "Business")
  if (blocked) return blocked
  const { id } = await params
  const [overview, staff] = await Promise.all([getAdminBusiness(id), getStaff()])
  if (!overview) notFound()
  const canProvision = can(staff, "accounts.provision")
  const { business, documents, checklist } = overview
  const approved = business.status === "approved"
  const provided = checklist.items.filter((i) => i.done).length

  const personName = (pid?: string) => business.people.find((p) => p._id === pid)?.fullName ?? "Removed person"
  const viewerDocs: ViewerDocument[] = documents.map((d) => ({
    ...d,
    label: d.type === "government_id" ? `${personName(d.person)}: photo ID` : DOCUMENT_TYPES[d.type],
    url: `/api/files/${business._id}/${d._id}`,
  }))

  const banking = (
    <>
      <BankAccountPanel
        businessId={business._id}
        businessName={business.name}
        businessStatus={business.status}
        liquifia={business.liquifia}
        account={headOfficeAccount(overview)}
        canProvision={canProvision}
      />
      {approved && (
        <BranchesPanel businessId={business._id} branches={overview.branches ?? []} canProvision={canProvision} />
      )}
    </>
  )

  return (
    <>
      <BusinessHeader
        overview={overview}
        staff={staff}
        tab="overview"
        actions={
          business.status === "submitted" &&
          can(staff, "kyb.review") && (
            <ReviewActions
              businessId={business._id}
              businessName={business.name}
              documents={viewerDocs.map((d) => ({ _id: d._id, label: d.label }))}
            />
          )
        }
      />

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div className="grid min-w-0 gap-6">
          {business.reviewNote && business.status !== "submitted" && (
            <figure
              className={cn(
                "surface border-l-4 p-5 sm:p-6",
                business.status === "rejected" ? "border-l-destructive" : "border-l-warning",
              )}
            >
              <figcaption className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <MessageSquareText className="size-4" aria-hidden />
                {business.status === "rejected" ? "Rejection reason" : "Last review note"}
                {business.reviewedBy && `, by ${business.reviewedBy.name}`}
                {business.reviewedAt && `, ${formatDateTime(business.reviewedAt)}`}
              </figcaption>
              <blockquote className="mt-2 text-sm whitespace-pre-line">{business.reviewNote}</blockquote>
            </figure>
          )}

          {/* Once approved, the account is what staff come here for; before that, the review is. */}
          {approved && banking}

          <AdminSection
            id="checklist"
            title="Checklist"
            aside={
              <span className="figure text-xs text-muted-foreground">
                {provided} of {checklist.items.length} provided
              </span>
            }
          >
            <ul className="grid gap-2 text-sm">
              {checklist.items.map((i) => (
                <li key={i.key} className="flex gap-2.5">
                  {i.done ? (
                    <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" aria-label="Provided" />
                  ) : (
                    <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning-foreground" aria-label="Missing" />
                  )}
                  <span className={cn(!i.done && "text-warning-foreground")}>
                    {i.label}
                    {i.rejectionReason && <span className="text-muted-foreground">: {i.rejectionReason}</span>}
                  </span>
                </li>
              ))}
            </ul>
          </AdminSection>

          <AdminSection id="details" title="Business details">
            <BusinessSummary business={business} />
          </AdminSection>

          <AdminSection
            id="people"
            title="Owners and directors"
            flush
            aside={<span className="figure text-xs text-muted-foreground">{business.people.length} added</span>}
          >
            {business.people.length === 0 ? (
              <p className="p-5 text-sm text-muted-foreground sm:px-6">No people added.</p>
            ) : (
              <Table className="min-w-120">
                <caption className="sr-only">Owners and directors of {business.name}</caption>
                <TableHeader className="bg-muted/60">
                  <TableRow className="hover:bg-transparent">
                    <TableHead scope="col" className="h-10 pl-5 text-xs text-muted-foreground sm:pl-6">Name</TableHead>
                    <TableHead scope="col" className="h-10 text-xs text-muted-foreground">BVN</TableHead>
                    <TableHead scope="col" className="h-10 text-xs text-muted-foreground">ID</TableHead>
                    <TableHead scope="col" className="h-10 pr-5 text-right text-xs text-muted-foreground sm:pr-6">Owns</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {business.people.map((p) => (
                    <TableRow key={p._id}>
                      <TableCell className="py-3 pl-5 sm:pl-6">
                        <div className="font-medium">{p.fullName}</div>
                        <div className="text-xs text-muted-foreground">{p.roles.map((r) => ROLE_LABELS[r]).join(", ")}</div>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{maskBVN(p.bvnLast4)}</TableCell>
                      <TableCell className="text-muted-foreground">{p.idType ? ID_TYPE_LABELS[p.idType] : "Not set"}</TableCell>
                      <TableCell className="pr-5 text-right figure sm:pr-6">
                        {p.ownershipPercent !== undefined ? `${p.ownershipPercent}%` : "Not given"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </AdminSection>

          {!approved && banking}
        </div>

        <AdminSection
          id="documents"
          title="Documents"
          flush
          className="xl:sticky xl:top-20"
          aside={<span className="figure text-xs text-muted-foreground">{documents.length} uploaded</span>}
        >
          <DocumentViewer documents={viewerDocs} canOpen={can(staff, "documents.view")} />
        </AdminSection>
      </div>
    </>
  )
}

/** The head office's account (the business's main account). Falls back to the first account. */
function headOfficeAccount(overview: Overview) {
  const headOffice = overview.branches?.find((b) => b.isHeadOffice)
  const branchId = (a: Overview["accounts"][number]) => (typeof a.branch === "string" ? a.branch : a.branch?._id)
  return overview.accounts?.find((a) => headOffice && branchId(a) === headOffice._id) ?? overview.accounts?.[0]
}
