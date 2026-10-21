"use client"

import { useSyncExternalStore } from "react"
import { useTheme } from "next-themes"
import { Monitor, Moon, Sun } from "lucide-react"
import { cn } from "@/lib/utils"

const OPTIONS = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
] as const

const noop = () => () => {}

/** Light, dark or system, for the navy auth band. The choice is unknown until mounted. */
export function ThemeSwitch() {
  const { theme, setTheme } = useTheme()
  const mounted = useSyncExternalStore(noop, () => true, () => false)

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="flex items-center gap-0.5 rounded-full bg-ink-foreground/[0.08] p-1 ring-1 ring-ink-foreground/10"
    >
      {OPTIONS.map(({ value, label, icon: Icon }) => {
        const checked = mounted && theme === value
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={label}
            title={label}
            onClick={() => setTheme(value)}
            className={cn(
              "grid size-8 place-items-center rounded-full transition-colors duration-150 focus-visible:ring-3 focus-visible:ring-pop/50 focus-visible:outline-none",
              checked
                ? "bg-pop text-pop-foreground"
                : "text-ink-muted hover:bg-ink-foreground/10 hover:text-ink-foreground",
            )}
          >
            <Icon className="size-4" aria-hidden />
          </button>
        )
      })}
    </div>
  )
}
