import Link from "next/link"
import { Logo } from "@/components/brand/logo"
import { Button } from "@/components/ui/button"

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 px-4">
      <Logo />
      <div className="grid gap-2">
        <h1 className="text-xl font-semibold tracking-tight">We can&apos;t find that page</h1>
        <p className="text-sm text-muted-foreground">The link may be old, or you may not have access to it.</p>
      </div>
      <Button className="w-fit" asChild>
        <Link href="/dashboard">Go to dashboard</Link>
      </Button>
    </main>
  )
}
