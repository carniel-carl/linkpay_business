import { Skeleton } from "@/components/ui/skeleton"

export function PageHeaderSkeleton() {
  return (
    <div className="mb-8 grid gap-2">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-4 w-80 max-w-full" />
    </div>
  )
}

export function FormSkeleton({ fields = 5 }: { fields?: number }) {
  return (
    <div className="grid gap-5" aria-busy aria-label="Loading">
      {Array.from({ length: fields }, (_, i) => (
        <div key={i} className="grid gap-2">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-9 w-full" />
        </div>
      ))}
    </div>
  )
}

export function TableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="overflow-hidden surface" aria-busy aria-label="Loading">
      <div className="h-10 border-b bg-muted/60" />
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex h-14 items-center gap-6 border-b px-4 last:border-0">
          <div className="grid flex-1 gap-1.5">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-3 w-32" />
          </div>
          <Skeleton className="hidden h-4 w-36 md:block" />
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-5 w-20" />
        </div>
      ))}
    </div>
  )
}
