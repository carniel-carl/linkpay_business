import { cn } from "@/lib/utils"

/**
 * One titled panel on the staff business page. Each section is its own surface, so panels never
 * nest inside each other. `flush` drops the body padding for tables and lists that run edge to edge.
 */
export function AdminSection({
  id,
  title,
  aside,
  flush = false,
  className,
  children,
}: {
  id: string
  title: string
  aside?: React.ReactNode
  flush?: boolean
  className?: string
  children: React.ReactNode
}) {
  return (
    <section aria-labelledby={`${id}-title`} className={cn("overflow-hidden surface", className)}>
      <header className="flex min-h-14 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b px-5 py-3 sm:px-6">
        <h2 id={`${id}-title`} className="font-display text-base font-semibold tracking-[-0.01em]">
          {title}
        </h2>
        {aside}
      </header>
      <div className={cn(!flush && "p-5 sm:p-6")}>{children}</div>
    </section>
  )
}
