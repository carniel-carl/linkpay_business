import { Skeleton } from "@/components/ui/skeleton"

/** The page title on the band, while the page loads. */
export function BandHeaderSkeleton({ back = false }: { back?: boolean }) {
  return (
    <div data-slot="page-header" className="band grid gap-3 pt-10 pb-[7.5rem] md:pt-14">
      {back && <Skeleton className="h-4 w-28 bg-brand-surface-foreground/10" />}
      <Skeleton className="h-10 w-72 max-w-full bg-brand-surface-foreground/10" />
      <Skeleton className="h-4 w-96 max-w-full bg-brand-surface-foreground/10" />
    </div>
  )
}

export function BusinessesTableSkeleton({ tabs = false }: { tabs?: boolean }) {
  return (
    <div className="overflow-hidden surface" aria-busy aria-label="Loading businesses">
      {tabs && (
        <div className="flex h-12 items-center gap-6 border-b px-4 sm:px-6">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-4 w-20" />
          ))}
        </div>
      )}
      <div className="flex items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <Skeleton className="h-9 w-full rounded-[10px] sm:w-80" />
        <Skeleton className="hidden h-8 w-24 rounded-full sm:block" />
      </div>
      <div className="h-11 border-y bg-muted/60" />
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="flex h-16 items-center gap-6 border-b px-4 last:border-0 sm:px-6">
          <div className="grid flex-1 gap-1.5">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-3 w-36" />
          </div>
          <Skeleton className="hidden h-4 w-32 md:block" />
          <Skeleton className="hidden h-4 w-24 sm:block" />
          <Skeleton className="h-6 w-24" />
        </div>
      ))}
    </div>
  )
}
