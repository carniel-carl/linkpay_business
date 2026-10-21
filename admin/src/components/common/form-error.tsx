import { CircleAlert } from "lucide-react"
import { Alert, AlertDescription } from "@/components/ui/alert"

/** Form-level error (react-hook-form `errors.root`). Announced to screen readers. */
export function FormError({ message }: { message?: string }) {
  if (!message) return null
  return (
    <Alert variant="destructive" role="alert" className="border-destructive/30 bg-destructive-subtle">
      <CircleAlert aria-hidden />
      <AlertDescription className="text-destructive">{message}</AlertDescription>
    </Alert>
  )
}
