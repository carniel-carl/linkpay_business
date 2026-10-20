import Link from "next/link"
import { Logo } from "@/components/brand/logo"
import { SUPPORT_EMAIL } from "@/lib/support"

export function SiteFooter() {
  return (
    <footer className="overflow-hidden">
      <div className="mx-auto grid max-w-[1400px] gap-10 px-4 pt-16 md:grid-cols-[minmax(0,1fr)_auto] md:items-end md:px-8">
        <div className="grid gap-4">
          <Logo />
          <p className="max-w-[48ch] text-sm leading-relaxed text-muted-foreground">
            LinkPay Business is for businesses registered in Nigeria. Accounts are held with our partner bank.
          </p>
        </div>
        <nav aria-label="Footer" className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
          <Link href="/sign-in" className="text-muted-foreground transition-colors hover:text-foreground">
            Sign in
          </Link>
          <Link href="/sign-up" className="text-muted-foreground transition-colors hover:text-foreground">
            Open an account
          </Link>
          <a href={`mailto:${SUPPORT_EMAIL}`} className="text-muted-foreground transition-colors hover:text-foreground">
            {SUPPORT_EMAIL}
          </a>
        </nav>
      </div>
      <p className="mx-auto max-w-[1400px] px-4 pt-10 text-xs text-muted-foreground md:px-8">© {new Date().getFullYear()} LinkPay</p>
      {/* The wordmark set large and cropped by the page edge. Decorative; the name is in the logo above. */}
      <p
        aria-hidden
        className="type-display -mb-[0.22em] mt-4 text-center text-[22vw] leading-none! text-foreground/[0.06] select-none"
      >
        LinkPay
      </p>
    </footer>
  )
}
