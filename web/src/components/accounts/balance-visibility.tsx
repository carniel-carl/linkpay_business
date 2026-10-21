"use client"

import { createContext, useCallback, useContext, useState } from "react"
import { Eye, EyeOff } from "lucide-react"
import { Button } from "@/components/ui/button"
import { BALANCES_HIDDEN_COOKIE, HIDDEN_AMOUNT } from "@/lib/balance-visibility"
import { formatNaira } from "@/lib/format"
import { cn } from "@/lib/utils"

// Hide or show balances (Home, Accounts, Savings). A browser preference kept in a cookie, like the sidebar's,
// so it outlives sign-out. Not a secret: it only decides what's drawn on screen.

const COOKIE_MAX_AGE = 60 * 60 * 24 * 365

const BalanceVisibilityContext = createContext<{ hidden: boolean; toggle: () => void }>({
  hidden: false,
  toggle: () => {},
})

export function BalanceVisibilityProvider({ defaultHidden, children }: { defaultHidden: boolean; children: React.ReactNode }) {
  const [hidden, setHidden] = useState(defaultHidden)
  const toggle = useCallback(() => {
    const next = !hidden
    setHidden(next)
    document.cookie = `${BALANCES_HIDDEN_COOKIE}=${next}; path=/; max-age=${COOKIE_MAX_AGE}; samesite=lax`
  }, [hidden])
  return <BalanceVisibilityContext value={{ hidden, toggle }}>{children}</BalanceVisibilityContext>
}

export const useBalanceVisibility = () => useContext(BalanceVisibilityContext)

/** A balance figure, or dots while balances are hidden (screen readers hear "hidden"). */
export function BalanceAmount({ kobo }: { kobo: number }) {
  const { hidden } = useBalanceVisibility()
  if (!hidden) return formatNaira(kobo)
  return (
    <>
      <span aria-hidden>{HIDDEN_AMOUNT}</span>
      <span className="sr-only">hidden</span>
    </>
  )
}

/** The eye beside "Available balance": hides or shows every balance at once. */
export function BalanceToggle({ className }: { className?: string }) {
  const { hidden, toggle } = useBalanceVisibility()
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      onClick={toggle}
      aria-label={hidden ? "Show balances" : "Hide balances"}
      aria-pressed={hidden}
      className={cn("text-muted-foreground hover:text-foreground", className)}
    >
      {hidden ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
    </Button>
  )
}
