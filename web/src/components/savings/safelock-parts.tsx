import { Lock, LockOpen } from "lucide-react"
import { cn } from "@/lib/utils"

/** A Safelock's tile: a lock on the brand tint, open once released. */
export function SafelockTile({ released, className }: { released?: boolean; className?: string }) {
  const Icon = released ? LockOpen : Lock
  return (
    <span
      className={cn("grid size-11 shrink-0 place-items-center rounded-[13px]", released ? "bg-muted" : "bg-brand-subtle", className)}
      aria-hidden
    >
      <Icon className={cn("size-[44%]", released ? "text-muted-foreground" : "text-primary")} strokeWidth={1.75} />
    </span>
  )
}

/** How far through its lock period a Safelock is. `bps` is 0..10000. */
export function LockProgress({ bps, label, className }: { bps: number; label: string; className?: string }) {
  const pct = Math.min(100, Math.max(0, bps / 100))
  return (
    <span
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.floor(pct)}
      className={cn("relative block h-1.5 overflow-hidden rounded-full bg-muted", className)}
    >
      <span
        className="absolute inset-y-0 left-0 rounded-full bg-primary transition-[width] duration-500 ease-out motion-reduce:transition-none"
        style={{ width: `${pct}%` }}
      />
    </span>
  )
}
