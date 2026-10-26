// Step-up (transaction signing) on the server side of the web: the proof a Server Action forwards with a
// money-out request. The dialog that collects it is components/security/step-up-dialog.tsx.
import { z } from "zod"
import type { StepUpProof } from "@/lib/api/types"

export const stepUpProof = z.object({ id: z.string().regex(/^[a-f\d]{24}$/i), code: z.string().regex(/^\d{6}$/) })

/** The headers the backend reads. Without a proof the backend answers STEP_UP_REQUIRED. */
export function stepUpHeaders(proof?: StepUpProof): Record<string, string> {
  if (!proof) return {}
  const { id, code } = stepUpProof.parse(proof)
  return { "X-Step-Up-Id": id, "X-Step-Up-Code": code }
}
