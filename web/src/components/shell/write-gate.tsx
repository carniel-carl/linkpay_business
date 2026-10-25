"use client"

import { createContext, isValidElement, useContext } from "react"
import { Slot } from "radix-ui"
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
  ...forwarded
}: {
  children: React.ReactNode
  /** Fills its box (a tile in a grid, a full-width button) instead of sitting inline. */
  block?: boolean
  className?: string
} & Omit<React.HTMLAttributes<HTMLElement>, "children" | "className"> & { ref?: React.Ref<HTMLElement> }) {
  const state = useReadOnly()
  // A trigger with `asChild` (a dialog's, a menu's) hands its props to its child. A `<Button write>` rendered by a
  // server component reaches the trigger already wrapped in this gate, so the props land here: pass them on to the
  // action, where they belong (its click handler, ref and ARIA state).
  const action = isValidElement(children) && Object.keys(forwarded).length > 0 ? <Slot.Root {...forwarded}>{children}</Slot.Root> : children
  if (!state.readOnly) return action

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
          // Inline, it hugs what it wraps, so a grid or a column doesn't stretch the tooltip's target past the button.
          className={cn(block ? "flex size-full" : "inline-flex w-fit max-w-full", "cursor-not-allowed", className)}
          onClickCapture={stop}
          // Also keeps the tooltip open on a click, which would otherwise close it.
          onPointerDownCapture={stop}
          onKeyDownCapture={(e) => OPENING_KEYS.has(e.key) && stop(e)}
          // Keyboard focus shows the reason. The focus a sheet puts on its first control when a click opens it (a
          // pocket's Add money) doesn't, so the tooltip doesn't cover what just opened; hovering still shows it.
          onFocus={(e) => !(e.target as HTMLElement).matches(":focus-visible") && e.preventDefault()}
        >
          <span
            className={cn(
              "pointer-events-none opacity-50",
              // A grid, so a button that filled its box (a footer, a grid cell) still does.
              block ? "grid size-full" : "inline-flex max-w-full flex-wrap items-center gap-2",
            )}
          >
            {action}
          </span>
          <span className="sr-only">{state.reason}</span>
        </span>
      </TooltipTrigger>
      {/* Kept off the screen's edges, so a control at the edge of a phone screen shows the whole reason. */}
      <TooltipContent collisionPadding={8}>{state.reason}</TooltipContent>
    </Tooltip>
  )
}
