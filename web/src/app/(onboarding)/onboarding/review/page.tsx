import type { Metadata } from "next"
import Link from "next/link"
import { ArrowLeft, CircleCheck, FileText, TriangleAlert } from "lucide-react"
import { BusinessSummary } from "@/components/business/business-summary"
import { PageHeader } from "@/components/common/page-header"
import { DocumentStatus } from "@/components/onboarding/document-dropzone"
import { Button } from "@/components/ui/button"
import { requireEditableOverview } from "@/lib/guards"
import { maskBVN } from "@/lib/format"
import { DOCUMENT_TYPES, ID_TYPE_LABELS, ROLE_LABELS } from "@/lib/kyb"
import { STEPS, stepForItem } from "@/lib/onboarding"
import { SubmitButton } from "./submit-button"

export const metadata: Metadata = { title: "Review and submit" }

export default async function ReviewPage() {
  const { business, documents, checklist } = await requireEditableOverview()
  const missing = checklist.items.filter((i) => !i.done)
  const resubmitting = business.status === "changes_requested"

  return (
    <>
      <PageHeader
        title={resubmitting ? "Review and resubmit" : "Review and submit"}
        description="Check everything is correct. While we review, you won't be able to make changes."
      />

      {missing.length > 0 ? (
        <section aria-labelledby="missing-title" className="mb-10 rounded-xl border border-warning/40 bg-warning-subtle/60 p-4">
          <h2 id="missing-title" className="flex items-center gap-2 text-sm font-medium text-warning-foreground">
            <TriangleAlert className="size-4" aria-hidden />
            {missing.length === 1 ? "1 thing left to do" : `${missing.length} things left to do`}
          </h2>
          <ul className="mt-3 grid gap-2 text-sm">
            {missing.map((item) => {
              const step = STEPS.find((s) => s.key === stepForItem(item.key))!
              return (
                <li key={item.key} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
                  <span>
                    {item.label}
                    {item.rejectionReason && <span className="text-muted-foreground">: {item.rejectionReason}</span>}
                  </span>
                  <Link href={step.href} className="shrink-0 font-medium text-primary underline-offset-4 hover:underline">
                    Go to {step.label.toLowerCase()}
                  </Link>
                </li>
              )
            })}
          </ul>
        </section>
      ) : (
        <p className="mb-10 flex items-center gap-2 rounded-xl border bg-brand-subtle/60 p-4 text-sm">
          <CircleCheck className="size-4 text-primary" aria-hidden />
          Everything we need is here. You can submit for review.
        </p>
      )}

      <div className="grid gap-10">
        <ReviewSection title="Business details" href="/onboarding/details">
          <BusinessSummary business={business} />
        </ReviewSection>

        <ReviewSection title="Owners and directors" href="/onboarding/people">
          {business.people.length === 0 ? (
            <p className="text-sm text-muted-foreground">No one added yet.</p>
          ) : (
            <ul className="divide-y surface">
              {business.people.map((p) => {
                const id = documents.find((d) => d.type === "government_id" && d.person === p._id)
                return (
                  <li key={p._id} className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 px-4 py-3 text-sm">
                    <div className="grid gap-0.5">
                      <span className="font-medium">{p.fullName}</span>
                      <span className="text-xs text-muted-foreground">{p.roles.map((r) => ROLE_LABELS[r]).join(", ")}</span>
                    </div>
                    <div className="flex items-center gap-4 text-xs text-muted-foreground">
                      <span className="font-mono">{maskBVN(p.bvnLast4)}</span>
                      <span>{p.idType ? ID_TYPE_LABELS[p.idType] : "No ID type"}</span>
                      {id ? <DocumentStatus status={id.status} /> : <span className="text-warning-foreground">ID missing</span>}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </ReviewSection>

        <ReviewSection title="Company documents" href="/onboarding/documents">
          <ul className="divide-y surface">
            {checklist.items
              .filter((i) => i.key.startsWith("document:"))
              .map((item) => {
                const type = item.key.slice("document:".length) as keyof typeof DOCUMENT_TYPES
                const doc = documents.find((d) => d.type === type && !d.person)
                return (
                  <li key={item.key} className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
                    <span className="flex min-w-0 items-center gap-2.5">
                      <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="truncate">{item.label}</span>
                    </span>
                    {doc ? <DocumentStatus status={doc.status} /> : <span className="shrink-0 text-xs text-warning-foreground">Missing</span>}
                  </li>
                )
              })}
          </ul>
        </ReviewSection>
      </div>

      <div className="mt-10 flex items-center justify-between gap-4 border-t pt-6">
        <Button variant="ghost" asChild>
          <Link href="/onboarding/documents">
            <ArrowLeft data-icon="inline-start" aria-hidden />
            Back
          </Link>
        </Button>
        <SubmitButton disabled={missing.length > 0} businessName={business.name} resubmitting={resubmitting} />
      </div>
    </>
  )
}

function ReviewSection({ title, href, children }: { title: string; href: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-4">
      <div className="flex items-center justify-between gap-4 border-b pb-2">
        <h2 className="text-sm font-medium">{title}</h2>
        <Link href={href} className="text-sm font-medium text-primary underline-offset-4 hover:underline">
          Edit
        </Link>
      </div>
      {children}
    </section>
  )
}
