import { ShieldOff } from "lucide-react"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"

/** Shown in place of a page the staff member's role doesn't cover. The backend refuses it anyway. */
export function NoAccess({ title, roleLabel }: { title: string; roleLabel: string }) {
  return (
    <Empty className="surface min-h-80 border-0 p-10">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <ShieldOff aria-hidden />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>
          Your role is {roleLabel}, which doesn&apos;t include this. Ask a super admin if you need it.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}
