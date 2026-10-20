import type { Business } from "@/lib/api/types"
import { BUSINESS_TYPE_INFO } from "@/lib/kyb"
import { cn } from "@/lib/utils"

/** Read-only definition list of a business's registration and contact details. */
export function BusinessSummary({ business, className }: { business: Business; className?: string }) {
  const a = business.address
  const rows: [string, React.ReactNode, boolean?][] = [
    ["Registered name", business.name],
    ["Type", BUSINESS_TYPE_INFO[business.type].label],
    ["RC / BN number", business.registrationNumber, true],
    ["TIN", business.tin, true],
    ["Industry", business.industry],
    ["Phone", business.phone],
    ["Email", business.email],
    ["Website", business.website],
    ["Address", [a?.street, a?.city, a?.state].filter(Boolean).join(", ")],
    ["About", business.description],
  ]
  return (
    <dl className={cn("grid gap-x-8 gap-y-4 text-sm sm:grid-cols-2", className)}>
      {rows.map(([label, value, mono]) => (
        <div key={label} className={cn("grid gap-0.5", label === "About" || label === "Address" ? "sm:col-span-2" : "")}>
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className={cn("break-words", mono && "font-mono", !value && "text-muted-foreground")}>{value || "Not provided"}</dd>
        </div>
      ))}
    </dl>
  )
}
