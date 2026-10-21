import { FileQuestion } from "lucide-react"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"

/** A customer followed a bad or old invoice link. They have no LinkPay account, so no dashboard link. */
export default function InvoiceNotFound() {
  return (
    <main className="grid min-h-dvh place-items-center bg-muted/50 px-4">
      <Empty className="surface max-w-md border-0 p-10">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FileQuestion aria-hidden />
          </EmptyMedia>
          <EmptyTitle>We can&apos;t find this invoice</EmptyTitle>
          <EmptyDescription>The link may be incomplete. Ask the business that sent it for a new link.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </main>
  )
}
