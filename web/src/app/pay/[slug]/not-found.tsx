import { Link2Off } from "lucide-react"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"

/** A payer followed a bad or removed payment link. They have no LinkPay account, so no dashboard link. */
export default function PayNotFound() {
  return (
    <main className="grid min-h-dvh place-items-center bg-muted/50 px-4">
      <Empty className="surface max-w-md border-0 p-10">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Link2Off aria-hidden />
          </EmptyMedia>
          <EmptyTitle>We can&apos;t find this payment link</EmptyTitle>
          <EmptyDescription>The link may be incomplete or no longer in use. Ask the business that shared it for a new one.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </main>
  )
}
