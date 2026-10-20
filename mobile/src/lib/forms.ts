import type { FieldValues, Path, UseFormReturn } from "react-hook-form";
import { ApiError, fieldErrorsFrom, friendlyMessage } from "@/lib/api/errors";

/** Puts a failed request on the form: field errors under their inputs, the rest as the form error. */
export function applyError<T extends FieldValues>(form: UseFormReturn<T>, err: unknown) {
  const fields = err instanceof ApiError ? fieldErrorsFrom(err.details) : undefined;
  if (fields) {
    for (const [name, message] of Object.entries(fields)) form.setError(name as Path<T>, { message });
    return;
  }
  form.setError("root", { message: friendlyMessage(err) });
}
