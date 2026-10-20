import Link from "next/link"
import { ShieldCheck } from "lucide-react"
import { Logo } from "@/components/brand/logo"

// On desktop the shell is locked to the viewport: the page never scrolls (so it can't bounce).
// The form column scrolls on its own, without overscroll, only if a window is very short.
/** The auth frame: the form on paper, a navy panel beside it on desktop. Used by sign-in pages and invite links. */
export function AuthShell({ children, aside }: { children: React.ReactNode; aside: React.ReactNode }) {
  return (
    <div className="grid min-h-dvh lg:h-dvh lg:grid-cols-[minmax(0,1fr)_minmax(0,34rem)] lg:overflow-hidden xl:grid-cols-[minmax(0,1fr)_minmax(0,38rem)]">
      <div className="flex flex-col px-4 py-6 sm:px-8 lg:h-dvh lg:overflow-y-auto lg:overscroll-none lg:px-12">
        <Link
          href="/"
          className="w-fit rounded-md focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <Logo />
        </Link>
        <main className="flex flex-1 items-center py-10">
          <div className="page-enter mx-auto w-full max-w-sm">{children}</div>
        </main>
        <p className="text-xs text-muted-foreground">LinkPay Business is for businesses registered in Nigeria.</p>
      </div>

      <aside className="hidden h-dvh p-3 lg:flex">
        <div className="grain flex h-full w-full flex-col overflow-hidden rounded-2xl bg-brand-surface p-10 text-brand-surface-foreground xl:p-12">
          <Logo inverse showProduct={false} />
          <div className="my-auto grid gap-10 py-8">{aside}</div>
          <p className="flex items-center gap-2 text-xs text-brand-surface-muted">
            <ShieldCheck className="size-4" aria-hidden />
            Accounts are held with our partner bank.
          </p>
        </div>
      </aside>
    </div>
  )
}

/** Headline block for the navy panel. */
export function AuthAsideHeadline({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="grid max-w-md gap-4">
      <h2 className="type-display text-[2.75rem] text-balance xl:text-[3.25rem] [@media(max-height:720px)]:text-[2.25rem]">
        {title}
      </h2>
      <p className="text-[15px] leading-relaxed text-brand-surface-muted">{children}</p>
    </div>
  )
}

/** A short icon list on the navy panel. Hidden on short windows so the panel never scrolls. */
export function AuthAsideList({
  label,
  items,
}: {
  label: string
  items: { icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>; title: string; detail: string }[]
}) {
  return (
    <div className="grid max-w-md gap-1 rounded-2xl border border-brand-surface-foreground/10 bg-brand-surface-foreground/[0.04] p-2 [@media(max-height:800px)]:hidden">
      <p className="px-3 pt-2 pb-1 text-xs font-medium text-brand-surface-muted">{label}</p>
      <ul className="grid">
        {items.map(({ icon: Icon, title, detail }) => (
          <li key={title} className="flex items-start gap-3 rounded-lg px-3 py-2.5">
            <span className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-primary/10 text-primary">
              <Icon className="size-4" aria-hidden />
            </span>
            <span className="grid gap-0.5">
              <span className="text-sm font-medium">{title}</span>
              <span className="text-xs leading-relaxed text-brand-surface-muted">{detail}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
