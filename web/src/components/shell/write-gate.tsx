"use client"

import { createContext, useContext } from "react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

type ReadOnly = { readOnly: false } | { readOnly: true; reason: string }

const ReadOnlyContext = createContext<ReadOnly>({ readOnly: false })

/**
 * Set by the dashboard layout while the business is suspended (lib/restriction.ts): reads work, writes are refused.
 * `reason` is what a disabled action says.
 */
export function ReadOnlyProvider({ reason, children }: { reason: string | null; children: React.ReactNode }) {
  return <ReadOnlyContext value={reason ? { readOnly: true, reason } : { readOnly: false }}>{children}</ReadOnlyContext>
}

export const useReadOnly = () => useContext(ReadOnlyContext)

const OPENING_KEYS = new Set(["Enter", " ", "ArrowDown", "ArrowUp"])

/**
 * Wrap a write action (a button, a link styled as one, a dialog or menu trigger) to show it dimmed and inert while
 * the business is read-only, with the reason as a tooltip. Otherwise it renders the action as it is. The action
 * stays focusable, so keyboard users reach the tooltip too; clicks and the keys that open menus are stopped before
 * they reach it. The API refuses the write anyway (BUSINESS_SUSPENDED); this saves a trip that can only fail.
 */
export function WriteGate({
  children,
  block,
  className,
}: {
  children: React.ReactNode
  /** Fills its box (a tile in a grid) instead of sitting inline. */
  block?: boolean
  className?: string
}) {
  const state = useReadOnly()
  if (!state.readOnly) return children

  const stop = (e: React.SyntheticEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }
  // aria-disabled on a group applies to the focusable things inside it.
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="group"
          aria-disabled="true"
          className={cn(block ? "flex size-full" : "inline-flex max-w-full", "cursor-not-allowed", className)}
          onClickCapture={stop}
          // Also keeps the tooltip open on a click, which would otherwise close it.
          onPointerDownCapture={stop}
          onKeyDownCapture={(e) => OPENING_KEYS.has(e.key) && stop(e)}
        >
          <span
            className={cn(
              "pointer-events-none opacity-50",
              block ? "flex size-full" : "inline-flex max-w-full flex-wrap items-center gap-2",
            )}
          >
            {children}
          </span>
          <span className="sr-only">{state.reason}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>{state.reason}</TooltipContent>
    </Tooltip>
  )
}
