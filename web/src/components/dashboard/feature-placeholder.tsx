import Link from "next/link"
import { Lock, type LucideIcon } from "lucide-react"
import { PageHeader } from "@/components/common/page-header"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { getOverview } from "@/lib/data"

type Props = { title: string; icon: LucideIcon; summary: string; detail: string }

/** Empty state for sections that aren't live yet. Locked instead until the business is verified. */
export async function FeaturePlaceholder({ title, icon: Icon, summary, detail }: Props) {
  const overview = await getOverview()
  const approved = overview?.business.status === "approved"

  return (
    <>
      <PageHeader title={title} description={summary} />
      <Empty className="surface min-h-96 border-0 p-10">
        <EmptyHeader>
          <EmptyMedia variant="icon">{approved ? <Icon aria-hidden /> : <Lock aria-hidden />}</EmptyMedia>
          <EmptyTitle>{approved ? `${title} is on the way` : "Available once you're verified"}</EmptyTitle>
          <EmptyDescription>
            {approved
              ? detail
              : `${title} opens up after we verify your business. Finish or check on your verification to get there.`}
          </EmptyDescription>
        </EmptyHeader>
        {!approved && (
          <EmptyContent>
            <Button variant="outline" asChild>
              <Link href={overview?.business.status === "draft" ? "/onboarding" : "/onboarding/status"}>
                {overview?.business.status === "draft" ? "Continue setup" : "View status"}
              </Link>
            </Button>
          </EmptyContent>
        )}
      </Empty>
    </>
  )
}
