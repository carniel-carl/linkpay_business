"use client"

import type { FieldValues, Path, UseFormReturn } from "react-hook-form"
import type { ActionResult } from "@/lib/action-result"

/**
 * Applies a failed ActionResult to a react-hook-form instance: backend zod issues go to their
 * fields, the summary goes to `root`. Returns true when the action succeeded.
 */
export function applyResult<T extends FieldValues, R>(
  form: UseFormReturn<T>,
  result: ActionResult<R>,
): result is { ok: true; data: R } {
  if (result.ok) return true
  const fieldErrors = Object.entries(result.fieldErrors ?? {})
  for (const [name, message] of fieldErrors) {
    form.setError(name as Path<T>, { type: "server", message })
  }
  if (!fieldErrors.length || result.code) {
    form.setError("root", { type: result.code ?? "server", message: result.error })
  }
  return false
}
