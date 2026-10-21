import { cn } from "@/lib/utils"

/**
 * Fixed dashboard header. Its left edge and width come from --dashboard-header-left and
 * --dashboard-header-width, set on the sidebar wrapper from the open/collapsed state, so it tracks
 * the content sheet and animates with the sidebar (same 200ms linear timing).
 */
export function PinnedHeader({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <>
      {/* Reserves the header's height in the flow. */}
      <div aria-hidden className="h-14 shrink-0" />
      <div
        className={cn(
          "fixed top-0 left-0 z-header w-full bg-sidebar md:pt-2",
          "md:left-(--dashboard-header-left) md:w-(--dashboard-header-width) md:transition-[left,width] md:duration-200 md:ease-linear",
        )}
      >
        <header
          className={cn(
            "flex h-14 items-center gap-3 bg-brand-surface px-4 text-brand-surface-foreground md:rounded-t-2xl md:px-8",
            className,
          )}
        >
          {children}
        </header>
      </div>
    </>
  )
}
