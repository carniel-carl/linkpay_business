import * as React from "react"
import { ChevronDown } from "lucide-react"
import { cn } from "cn"

/**
 * A real <select>, styled like Input. Use it where browser autofill should fill the value (for
 * example an address's state). Radix Select is filled through a visually hidden native select,
 * the likely trigger of a Chrome tab crash during address autofill (see branch-form-dialog.tsx).
 */
function NativeSelect({ className, children, ...props }: React.ComponentProps<"select">) {
  return (
    <div data-slot="native-select-wrapper" className="relative w-full">
      <select
        data-slot="native-select"
        className={cn(
          "h-9 w-full min-w-0 appearance-none rounded-lg border border-input bg-transparent py-1 pr-9 pl-3 text-base transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&:has(option[value='']:checked)]:text-muted-foreground",
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden
        className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground"
      />
    </div>
  )
}

export { NativeSelect }
