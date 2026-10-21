import { Badge } from "@/components/ui/badge"
import type { Pocket, PocketColor, PocketIcon } from "@/lib/api/types"
import { formatNaira } from "@/lib/format"
import { autoSaveTag, formatDay, POCKET_ICONS, pocketColorStyle } from "@/lib/savings"
import { cn } from "@/lib/utils"

/** The pocket's icon on its colour (a squircle tile); the savings icon when it has none. */
export function PocketTile({ icon, color, className }: { icon: PocketIcon | null; color: PocketColor; className?: string }) {
  const { Icon } = POCKET_ICONS[icon ?? "savings"] ?? POCKET_ICONS.savings
  return (
    <span
      style={pocketColorStyle(color)}
      className={cn("grid size-11 shrink-0 place-items-center rounded-[13px] bg-(--pc-subtle)", className)}
      aria-hidden
    >
      <Icon className="size-[46%] text-foreground/75" strokeWidth={1.75} />
    </span>
  )
}

/** Thin bar in the pocket's colour. `bps` is 0..10000. */
export function PocketProgress({ bps, color, className }: { bps: number; color: PocketColor; className?: string }) {
  const pct = Math.min(100, Math.max(0, bps / 100))
  return (
    <span
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.floor(pct)}
      style={pocketColorStyle(color)}
      className={cn("relative block h-1.5 overflow-hidden rounded-full bg-muted", className)}
    >
      <span
        className="absolute inset-y-0 left-0 rounded-full bg-(--pc) transition-[width] duration-500 ease-out motion-reduce:transition-none"
        style={{ width: `${pct}%` }}
      />
    </span>
  )
}

/** "₦40,000.00 of ₦100,000.00 · by 15 Mar 2027", or "Target reached". */
export function TargetLine({ pocket, className }: { pocket: Pocket; className?: string }) {
  const t = pocket.target
  if (!t) return null
  const reached = t.remainingKobo === 0
  return (
    <p className={cn("flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-xs text-muted-foreground", className)}>
      <span>
        {reached ? (
          <>
            Reached <span className="figure">{formatNaira(t.amountKobo)}</span>
          </>
        ) : (
          <>
            <span className="figure">{formatNaira(t.remainingKobo)}</span> to go of <span className="figure">{formatNaira(t.amountKobo)}</span>
          </>
        )}
      </span>
      {t.date && !reached && <span>by {formatDay(t.date)}</span>}
    </p>
  )
}

/** Tags under a pocket's name: target reached, auto-saving, closed. */
export function PocketTags({ pocket }: { pocket: Pocket }) {
  const auto = pocket.status === "active" ? autoSaveTag(pocket.autoSave) : null
  const reached = pocket.status === "active" && pocket.target && pocket.target.remainingKobo === 0
  if (!auto && !reached && pocket.status === "active") return null
  return (
    <span className="flex flex-wrap gap-1.5">
      {pocket.status === "closed" && <Badge variant="muted">Closed</Badge>}
      {reached && <Badge variant="success">Target reached</Badge>}
      {auto && <Badge variant="outline">{auto}</Badge>}
    </span>
  )
}
