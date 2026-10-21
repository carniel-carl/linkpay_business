import type { BusinessStatus, ChecklistItem, Overview } from "@/lib/api/types";

// Mirrors web/src/lib/onboarding.ts: the wizard's steps and how far each one is.

export type StepKey = "type" | "details" | "people" | "documents" | "review";

export type StepHref = "/onboarding/type" | "/onboarding/details" | "/onboarding/people" | "/onboarding/documents" | "/onboarding/review";

export const STEPS: { key: StepKey; href: StepHref; label: string }[] = [
  { key: "type", href: "/onboarding/type", label: "Business type" },
  { key: "details", href: "/onboarding/details", label: "Business details" },
  { key: "people", href: "/onboarding/people", label: "Owners and directors" },
  { key: "documents", href: "/onboarding/documents", label: "Documents" },
  { key: "review", href: "/onboarding/review", label: "Review and submit" },
];

/** Which step a checklist item belongs to, from its key (see backend services/kyb.ts). */
export function stepForItem(key: string): StepKey {
  if (key.startsWith("field:")) return "details";
  if (key.startsWith("document:")) return "documents";
  return "people"; // people:principal, person:<id>:bvn|idType|government_id
}

export type StepState = (typeof STEPS)[number] & { done: boolean; total: number; completed: number; needsAttention: boolean };

export function stepStates(overview: Overview | undefined): StepState[] {
  const items = overview?.checklist.items ?? [];
  return STEPS.map((step) => {
    if (step.key === "type") return { ...step, done: !!overview, total: 1, completed: overview ? 1 : 0, needsAttention: false };
    if (step.key === "review") {
      const done = !!overview && !EDITABLE.includes(overview.business.status);
      return { ...step, done, total: 0, completed: 0, needsAttention: false };
    }
    const list = items.filter((i) => stepForItem(i.key) === step.key);
    const completed = list.filter((i) => i.done).length;
    return {
      ...step,
      done: !!overview && list.length > 0 && completed === list.length,
      total: list.length,
      completed,
      needsAttention: list.some((i) => i.rejectionReason),
    };
  });
}

/** The business can be edited only while it's being set up or was sent back. */
export const EDITABLE: BusinessStatus[] = ["draft", "changes_requested"];

/** Onboarding is the owner's job (as on the web); team members of someone else's business never edit it. */
export const isOwner = (overview: Overview | undefined) => !overview?.membership || overview.membership.role === "owner";

/** The step after `key`, for "Save and continue". */
export const nextStep = (key: StepKey) => STEPS[STEPS.findIndex((s) => s.key === key) + 1];

export const missingItems = (items: ChecklistItem[]) => items.filter((i) => !i.done);

/** Where to fix a checklist item. */
export const stepFor = (item: ChecklistItem) => STEPS.find((s) => s.key === stepForItem(item.key))!;

/** "BVN" from "Ada Obi: BVN": a person's item without their name. */
export const itemPart = (item: ChecklistItem) => item.label.split(": ").pop() ?? item.label;

/** "•••• 1234" for a saved BVN, as on the web. */
export const maskBvn = (last4?: string) => (last4 ? `•••• ${last4}` : "Not added");
