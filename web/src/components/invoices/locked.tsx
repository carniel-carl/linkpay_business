import { Lock } from "lucide-react"
import { PageHeader } from "@/components/common/page-header"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"

/** For members who can't see invoices (no `accounts.view`), or can't create them (no `invoices.manage`). */
export function InvoicesLocked({ action = false }: { action?: boolean }) {
  return (
    <>
      <PageHeader title="Invoices" description="Bill customers and track what they owe." />
      <Empty className="surface min-h-80 border-0 p-10">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Lock aria-hidden />
          </EmptyMedia>
          <EmptyTitle>{action ? "Creating invoices isn't part of your role" : "Invoices aren't part of your role"}</EmptyTitle>
          <EmptyDescription>Ask the business owner or an admin if you need to create or send invoices.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </>
  )
}
