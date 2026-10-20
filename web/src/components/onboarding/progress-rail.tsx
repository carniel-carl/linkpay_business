"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { Check, TriangleAlert } from "lucide-react"
import type { StepState } from "@/lib/onboarding"
import { cn } from "@/lib/utils"

type Props = {
  steps: StepState[]
  locked: boolean
}

export function ProgressRail({ steps, locked }: Props) {
  const pathname = usePathname()
  const hasBusiness = steps[0].done

  return (
    <nav aria-label="Business verification steps" className="lg:sticky lg:top-24 lg:self-start lg:border-r lg:pr-8">
      <ol className="-mx-4 flex snap-x gap-1 overflow-x-auto px-4 pb-1 lg:mx-0 lg:grid lg:overflow-visible lg:px-0">
        {steps.map((step, index) => {
          const current = pathname === step.href
          const reachable = !locked && (index === 0 || hasBusiness)
          const content = (
            <>
              <StepMarker index={index} done={step.done} attention={step.needsAttention} current={current} />
              <span className="grid min-w-0">
                <span className={cn("truncate text-sm", current ? "font-medium text-foreground" : "text-muted-foreground")}>
                  {step.label}
                </span>
                {step.total > 1 && (
                  <span className="hidden text-xs text-muted-foreground figure lg:block">
                    {step.needsAttention ? "Needs your attention" : `${step.completed} of ${step.total} done`}
                  </span>
                )}
              </span>
            </>
          )
          const className = cn(
            "flex shrink-0 snap-start items-center gap-3 rounded-lg px-2.5 py-2 transition-colors duration-150",
            current && "bg-muted",
            reachable && !current && "hover:bg-muted/60",
          )
          return (
            <li key={step.key}>
              {reachable ? (
                <Link href={step.href} className={cn(className, "focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none")} aria-current={current ? "step" : undefined}>
                  {content}
                </Link>
              ) : (
                <span className={cn(className, "cursor-default opacity-70")} aria-disabled>
                  {content}
                </span>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

function StepMarker({ index, done, attention, current }: { index: number; done: boolean; attention: boolean; current: boolean }) {
  if (attention) {
    return (
      <span className="grid size-6 shrink-0 place-items-center rounded-full bg-warning-subtle text-warning-foreground">
        <TriangleAlert className="size-3.5" aria-label="Needs attention" />
      </span>
    )
  }
  if (done) {
    return (
      <span className="grid size-6 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground">
        <Check className="size-3.5" aria-label="Done" />
      </span>
    )
  }
  return (
    <span
      className={cn(
        "grid size-6 shrink-0 place-items-center rounded-full border text-xs font-medium figure",
        current ? "border-primary text-primary" : "border-input text-muted-foreground",
      )}
    >
      {index + 1}
    </span>
  )
}
