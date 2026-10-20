import type { Balance } from "@/lib/api/types"
import { formatNaira } from "@/lib/format"
import { cn } from "@/lib/utils"

/** What can be sent: the bank balance minus what transfers are holding. Older backends only send `amountKobo`. */
export const availableKobo = (balance: Balance) => balance.availableKobo ?? balance.amountKobo

export const heldKobo = (balance: Balance) => balance.heldKobo ?? 0

/** "₦5,000.00 held for transfers", only when transfers are holding money (waiting for approval or for the bank). */
export function HeldNote({ kobo, short, className }: { kobo: number; short?: boolean; className?: string }) {
  if (kobo <= 0) return null
  return (
    <span className={cn("text-xs text-muted-foreground", className)}>
      <span className="figure">{formatNaira(kobo)}</span> {short ? "held" : "held for transfers"}
    </span>
  )
}
