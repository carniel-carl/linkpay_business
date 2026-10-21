import { Badge } from "@/components/ui/badge"
import type { KybDocument } from "@/lib/api/types"

export function DocumentStatus({ status }: { status: KybDocument["status"] }) {
  if (status === "accepted") return <Badge variant="success">Accepted</Badge>
  if (status === "rejected") return <Badge variant="warning">Needs a new file</Badge>
  return <Badge variant="muted">Uploaded</Badge>
}
