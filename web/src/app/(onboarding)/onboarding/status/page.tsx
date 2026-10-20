import type { Metadata } from "next"
import Link from "next/link"
import { redirect } from "next/navigation"
import { ArrowRight, Check, Clock, Mail, MessageSquareWarning, XCircle } from "lucide-react"
import { StatusBadge } from "@/components/business/status-badge"
import { PageHeader } from "@/components/common/page-header"
import { Button } from "@/components/ui/button"
import type { ChecklistItem } from "@/lib/api/types"
import { getOverview } from "@/lib/data"
import { formatDate, formatDateTime } from "@/lib/format"
import { STEPS, stepForItem } from "@/lib/onboarding"
import { SUPPORT_EMAIL } from "@/lib/support"
import { cn } from "@/lib/utils"

export const metadata: Metadata = { title: "Verification status" }

export default async function StatusPage() {
  const overview = await getOverview()
  if (!overview) redirect("/onboarding")
  const { business, checklist } = overview

  switch (business.status) {
    case "draft":
      redirect("/onboarding/review")
    case "approved":
      redirect("/dashboard")
    case "submitted":
      return <Submitted name={business.name} submittedAt={business.submittedAt} />
    case "changes_requested":
      return (
        <ChangesRequested
          note={business.reviewNote}
          reviewedAt={business.reviewedAt}
          rejected={checklist.items.filter((i) => i.rejectionReason)}
          outstanding={checklist.items.filter((i) => !i.done && !i.rejectionReason)}
        />
      )
    case "rejected":
      return <Rejected name={business.name} reason={business.reviewNote} reviewedAt={business.reviewedAt} />
  }
}

function Submitted({ name, submittedAt }: { name: string; submittedAt?: string }) {
  const timeline = [
    { title: "Submitted", body: `You sent us ${name}'s details on ${formatDate(submittedAt)}.`, state: "done" },
    {
      title: "We check your documents",
      body: "We match your CAC records, TIN and each person's BVN and ID. This usually takes 1 to 2 business days.",
      state: "current",
    },
    { title: "You hear from us", body: "We'll email you once we've decided. If anything needs fixing, we'll say exactly what.", state: "next" },
  ] as const

  return (
    <>
      <PageHeader
        title="We're reviewing your business"
        description="There's nothing you need to do right now. You can explore your dashboard while you wait."
        actions={<StatusBadge status="submitted" />}
      />
      <ol className="grid gap-0">
        {timeline.map((step, i) => (
          <li key={step.title} className="grid grid-cols-[auto_1fr] gap-x-4">
            <div className="flex flex-col items-center">
              <span
                className={cn(
                  "grid size-7 place-items-center rounded-full border",
                  step.state === "done" && "border-primary bg-primary text-primary-foreground",
                  step.state === "current" && "border-primary text-primary",
                  step.state === "next" && "text-muted-foreground",
                )}
              >
                {step.state === "done" ? <Check className="size-3.5" aria-hidden /> : step.state === "current" ? <Clock className="size-3.5" aria-hidden /> : <Mail className="size-3.5" aria-hidden />}
              </span>
              {i < timeline.length - 1 && <span className="my-1 w-px flex-1 bg-border" aria-hidden />}
            </div>
            <div className="pb-8">
              <p className={cn("text-sm font-medium", step.state === "next" && "text-muted-foreground")}>{step.title}</p>
              <p className="mt-1 text-sm text-muted-foreground">{step.body}</p>
            </div>
          </li>
        ))}
      </ol>
      <Button variant="outline" asChild>
        <Link href="/dashboard">
          Go to dashboard
          <ArrowRight data-icon="inline-end" aria-hidden />
        </Link>
      </Button>
    </>
  )
}

function ChangesRequested({
  note,
  reviewedAt,
  rejected,
  outstanding,
}: {
  note?: string
  reviewedAt?: string
  rejected: ChecklistItem[]
  outstanding: ChecklistItem[]
}) {
  return (
    <>
      <PageHeader
        title="We need a few changes"
        description="Update the items below, then resubmit. Everything else you sent is saved."
        actions={<StatusBadge status="changes_requested" />}
      />
      {note && (
        <figure className="mb-8 rounded-xl border border-warning/40 bg-warning-subtle/60 p-4">
          <figcaption className="flex items-center gap-2 text-xs font-medium text-warning-foreground">
            <MessageSquareWarning className="size-4" aria-hidden />
            Note from our review team{reviewedAt && `, ${formatDateTime(reviewedAt)}`}
          </figcaption>
          <blockquote className="mt-2 text-sm whitespace-pre-line">{note}</blockquote>
        </figure>
      )}

      {rejected.length > 0 && (
        <section className="mb-8 grid gap-3">
          <h2 className="text-sm font-medium">Documents to replace</h2>
          <ul className="divide-y surface">
            {rejected.map((item) => (
              <FixRow key={item.key} item={item} />
            ))}
          </ul>
        </section>
      )}

      {outstanding.length > 0 && (
        <section className="mb-8 grid gap-3">
          <h2 className="text-sm font-medium">Also missing</h2>
          <ul className="divide-y surface">
            {outstanding.map((item) => (
              <FixRow key={item.key} item={item} />
            ))}
          </ul>
        </section>
      )}

      <Button asChild>
        <Link href="/onboarding/review">
          Review and resubmit
          <ArrowRight data-icon="inline-end" aria-hidden />
        </Link>
      </Button>
    </>
  )
}

function FixRow({ item }: { item: ChecklistItem }) {
  const step = STEPS.find((s) => s.key === stepForItem(item.key))!
  return (
    <li className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2 px-4 py-3">
      <div className="grid gap-0.5 text-sm">
        <span className="font-medium">{item.label}</span>
        {item.rejectionReason && <span className="text-muted-foreground">{item.rejectionReason}</span>}
      </div>
      <Button variant="outline" size="sm" asChild>
        <Link href={step.href}>Fix this</Link>
      </Button>
    </li>
  )
}

function Rejected({ name, reason, reviewedAt }: { name: string; reason?: string; reviewedAt?: string }) {
  return (
    <>
      <PageHeader
        title="We couldn't approve your business"
        description={`After reviewing ${name}, we're unable to open a LinkPay Business account for it.`}
        actions={<StatusBadge status="rejected" />}
      />
      <figure className="mb-8 rounded-xl border border-destructive/30 bg-destructive-subtle/60 p-4">
        <figcaption className="flex items-center gap-2 text-xs font-medium text-destructive">
          <XCircle className="size-4" aria-hidden />
          Reason{reviewedAt && `, ${formatDate(reviewedAt)}`}
        </figcaption>
        <blockquote className="mt-2 text-sm whitespace-pre-line">{reason ?? "No reason was given."}</blockquote>
      </figure>
      <div className="grid gap-3 text-sm">
        <p className="text-muted-foreground">
          If you think this is a mistake or your circumstances have changed, email our support team with your business
          name and RC or BN number.
        </p>
        <Button variant="outline" className="w-fit" asChild>
          <a href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(`Verification: ${name}`)}`}>
            <Mail data-icon="inline-start" aria-hidden />
            {SUPPORT_EMAIL}
          </a>
        </Button>
      </div>
    </>
  )
}
