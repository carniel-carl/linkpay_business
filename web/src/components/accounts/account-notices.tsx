import { CloudOff, Hourglass, MailCheck, RotateCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"

/** Account being set up (or setup failed and our team is retrying). Never shows a technical error. */
export function AccountSetupNotice({
  failed,
  polling,
  refreshing,
  onCheck,
  className,
}: {
  failed: boolean
  polling: boolean
  refreshing: boolean
  onCheck: () => void
  className?: string
}) {
  return (
    <section
      aria-live="polite"
      className={cn("surface grid gap-8 overflow-hidden p-6 sm:p-9 md:grid-cols-[minmax(0,1fr)_auto] md:items-end", className)}
    >
      <div className="grid gap-5">
        <span className="grid size-11 place-items-center rounded-[12px] bg-brand-subtle text-primary">
          {failed ? <MailCheck className="size-5" aria-hidden /> : <Hourglass className="size-5" aria-hidden />}
        </span>
        <div className="grid gap-3">
          <h2 className="type-display text-[2rem] sm:text-[2.5rem]">
            {failed ? "Almost there" : "Setting up your business account"}
          </h2>
          <p className="max-w-[52ch] text-[15px] leading-relaxed text-muted-foreground">
            {failed
              ? "We're finishing your account setup. You'll get an email once it's ready."
              : "Your business is verified and we're opening your naira account with our partner bank. We'll email you the account number as soon as it's ready."}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        {polling ? (
          <>
            <Spinner className="text-primary" />
            Checking for your account
          </>
        ) : (
          <Button variant="outline" size="sm" onClick={onCheck} disabled={refreshing}>
            {refreshing ? <Spinner /> : <RotateCw data-icon="inline-start" aria-hidden />}
            Check again
          </Button>
        )}
      </div>
    </section>
  )
}

/** Banking partner unreachable (502 PROVIDER_ERROR) or another temporary failure. */
export function ProviderDownNotice({
  refreshing,
  onRetry,
  className,
  title = "We can't load your account right now",
}: {
  refreshing: boolean
  onRetry: () => void
  className?: string
  title?: string
}) {
  return (
    <section aria-live="polite" className={cn("surface grid gap-6 p-6 sm:p-9", className)}>
      <span className="grid size-11 place-items-center rounded-[12px] bg-muted text-muted-foreground">
        <CloudOff className="size-5" aria-hidden />
      </span>
      <div className="grid gap-2">
        <h2 className="font-display text-xl font-semibold tracking-[-0.02em]">{title}</h2>
        <p className="max-w-[52ch] text-[15px] leading-relaxed text-muted-foreground">
          Our banking partner isn&apos;t responding. Your money is safe; this only affects what we can show you. Try again
          in a moment.
        </p>
      </div>
      <Button variant="outline" className="w-fit" onClick={onRetry} disabled={refreshing}>
        {refreshing ? <Spinner /> : <RotateCw data-icon="inline-start" aria-hidden />}
        Try again
      </Button>
    </section>
  )
}
