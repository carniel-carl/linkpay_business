"use client"

import { cn } from "@/lib/utils"

/**
 * A tile whose border and surface light up under the pointer. The pointer position is written
 * straight to CSS variables on the element, so moving the mouse never re-renders React.
 */
export function Spotlight({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div
      onPointerMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect()
        e.currentTarget.style.setProperty("--x", `${e.clientX - r.left}px`)
        e.currentTarget.style.setProperty("--y", `${e.clientY - r.top}px`)
      }}
      className={cn(
        "group/spot relative isolate overflow-hidden rounded-[1.75rem]",
        // A soft lime glow that follows the pointer, behind the content and above any photo (-z-10).
        "before:pointer-events-none before:absolute before:inset-0 before:-z-[5] before:rounded-[inherit] before:opacity-0 before:transition-opacity before:duration-500 hover:before:opacity-100",
        "before:bg-[radial-gradient(420px_circle_at_var(--x)_var(--y),color-mix(in_oklch,var(--pop),transparent_82%),transparent_60%)]",
        className,
      )}
    >
      {children}
    </div>
  )
}
