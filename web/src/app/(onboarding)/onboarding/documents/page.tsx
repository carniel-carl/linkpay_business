import type { Metadata } from "next"
import Link from "next/link"
import { ArrowLeft, ArrowRight, Check } from "lucide-react"
import { PageHeader } from "@/components/common/page-header"
import { DocumentDropzone } from "@/components/onboarding/document-dropzone"
import { Button } from "@/components/ui/button"
import { requireEditableOverview } from "@/lib/guards"
import { BUSINESS_TYPE_INFO, type DocumentType } from "@/lib/kyb"

export const metadata: Metadata = { title: "Documents" }

export default async function DocumentsPage() {
  const { business, documents, checklist } = await requireEditableOverview()
  // Required documents come from the checklist, which depends on the business type.
  const required = checklist.items.filter((i) => i.key.startsWith("document:"))
  const done = required.filter((i) => i.done).length

  return (
    <>
      <PageHeader
        title="Company documents"
        description={
          <>
            A {BUSINESS_TYPE_INFO[business.type].label.toLowerCase()} needs these {required.length} documents. Clear scans
            or photos work. Each person&apos;s ID is uploaded on the{" "}
            <Link href="/onboarding/people" className="font-medium text-primary underline-offset-4 hover:underline">
              owners and directors
            </Link>{" "}
            step.
          </>
        }
      />

      <ul className="grid gap-6">
        {required.map((item) => {
          const type = item.key.slice("document:".length) as DocumentType
          const document = documents.find((d) => d.type === type && !d.person)
          return (
            <li key={item.key} className="grid gap-2">
              <div className="flex items-center gap-2">
                {item.done && <Check className="size-4 shrink-0 text-primary" aria-label="Done" />}
                <h2 className="text-sm font-medium">{item.label}</h2>
              </div>
              <DocumentDropzone type={type} label={item.label} document={document} />
            </li>
          )
        })}
      </ul>

      <div className="mt-10 flex items-center justify-between gap-4 border-t pt-6">
        <Button variant="ghost" asChild>
          <Link href="/onboarding/people">
            <ArrowLeft data-icon="inline-start" aria-hidden />
            Back
          </Link>
        </Button>
        <div className="flex items-center gap-4">
          <span className="hidden text-xs text-muted-foreground figure sm:inline">
            {done} of {required.length} uploaded
          </span>
          <Button asChild>
            <Link href="/onboarding/review">
              Continue
              <ArrowRight data-icon="inline-end" aria-hidden />
            </Link>
          </Button>
        </div>
      </div>
    </>
  )
}
