import type { ChecklistItem, Overview } from "@/lib/api/types"
import type { BusinessStatus } from "@/lib/kyb"

export type StepKey = "type" | "details" | "people" | "documents" | "review"

export const STEPS: { key: StepKey; href: string; label: string }[] = [
  { key: "type", href: "/onboarding", label: "Business type" },
  { key: "details", href: "/onboarding/details", label: "Business details" },
  { key: "people", href: "/onboarding/people", label: "Owners and directors" },
  { key: "documents", href: "/onboarding/documents", label: "Documents" },
  { key: "review", href: "/onboarding/review", label: "Review and submit" },
]

/** Which wizard step a checklist item belongs to, from its key (see backend services/kyb.ts). */
export function stepForItem(key: string): StepKey {
  if (key.startsWith("field:")) return "details"
  if (key.startsWith("document:")) return "documents"
  return "people" // people:principal, person:<id>:bvn|idType|government_id
}

export type StepState = {
  key: StepKey
  href: string
  label: string
  done: boolean
  total: number
  completed: number
  needsAttention: boolean
}

export function stepStates(overview: Overview | null): StepState[] {
  const items = overview?.checklist.items ?? []
  const byStep = (k: StepKey) => items.filter((i) => stepForItem(i.key) === k)
  return STEPS.map((step) => {
    if (step.key === "type") {
      return { ...step, done: !!overview, total: 1, completed: overview ? 1 : 0, needsAttention: false }
    }
    if (step.key === "review") {
      const done = !!overview && overview.business.status !== "draft" && overview.business.status !== "changes_requested"
      return { ...step, done, total: 0, completed: 0, needsAttention: false }
    }
    const list = byStep(step.key)
    const completed = list.filter((i) => i.done).length
    return {
      ...step,
      done: !!overview && list.length > 0 && completed === list.length,
      total: list.length,
      completed,
      needsAttention: list.some((i) => i.rejectionReason),
    }
  })
}

export const EDITABLE: BusinessStatus[] = ["draft", "changes_requested"]

export function missingItems(items: ChecklistItem[]) {
  return items.filter((i) => !i.done)
}
