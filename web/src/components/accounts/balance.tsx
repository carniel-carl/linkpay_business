import Link from "next/link"
import type { Balance } from "@/lib/api/types"
import { cn } from "@/lib/utils"
import { BalanceAmount } from "./balance-visibility"

/** What can be sent: the bank balance minus what transfers are holding. Older backends only send `amountKobo`. */
export const availableKobo = (balance: Balance) => balance.availableKobo ?? balance.amountKobo

export const heldKobo = (balance: Balance) => balance.heldKobo ?? 0

export const savedKobo = (balance: Balance) => balance.savedKobo ?? 0

/** "₦5,000.00 held for transfers", only when transfers are holding money (waiting for approval or for the bank). */
export function HeldNote({ kobo, short, className }: { kobo: number; short?: boolean; className?: string }) {
  if (kobo <= 0) return null
  return (
    <span className={cn("text-xs text-muted-foreground", className)}>
      <span className="figure">
        <BalanceAmount kobo={kobo} />
      </span>{" "}
      {short ? "held" : "held for transfers"}
    </span>
  )
}

/** "₦50,000.00 in savings", linking to Savings, only when pockets hold money on the account. */
export function SavedNote({ kobo, short, className }: { kobo: number; short?: boolean; className?: string }) {
  if (kobo <= 0) return null
  return (
    <Link
      href="/savings"
      className={cn("w-fit text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline", className)}
    >
      <span className="figure">
        <BalanceAmount kobo={kobo} />
      </span>{" "}
      {short ? "saved" : "in savings"}
    </Link>
  )
}
