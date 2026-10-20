import Link from "next/link"
import { cn } from "@/lib/utils"

/** Underlined tab-style navigation between pages (real links, so history and new tabs work). */
export function NavTabs({
  items,
  current,
  label,
  className,
}: {
  items: { href: string; label: string; key: string }[]
  current: string
  label: string
  className?: string
}) {
  return (
    <nav aria-label={label} className={cn("-mx-4 overflow-x-auto px-4", className)}>
      <ul className="flex w-max min-w-full gap-1 border-b">
        {items.map((item) => {
          const active = item.key === current
          return (
            <li key={item.key}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "-mb-px inline-flex h-9 items-center border-b-2 px-3 text-sm whitespace-nowrap transition-colors duration-150",
                  "rounded-t-md focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                  active ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {item.label}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
