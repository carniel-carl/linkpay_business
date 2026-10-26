import Link from "next/link"
import { AdminSection } from "@/components/admin/admin-section"
import { FreezeButtons, RequestStatusBadge } from "@/components/security/security-parts"
import { Badge } from "@/components/ui/badge"
import type { BusinessSecurityView } from "@/lib/api/types"
import { formatDateTime } from "@/lib/format"
import { describeRequest } from "@/lib/security"

const FROZEN_BY = { member: "a team member", report: "a \"This wasn't me\" report", staff: "LinkPay staff" } as const

/** A business's money-out protection on its Compliance tab (security.review): freeze, settlement accounts, open requests. */
export function MoneyOutPanel({ businessId, view }: { businessId: string; view: BusinessSecurityView }) {
  const { frozen, settlementOnly } = view.moneyOut
  const open = view.requests.filter((r) => r.status === "pending" || r.status === "approved")
  const accounts = view.settlementAccounts.filter((a) => a.status === "active" || a.status === "pending")
  return (
    <AdminSection id="money-out" title="Money out" flush aside={<FreezeButtons businessId={businessId} frozen={!!frozen} />}>
      <div className="grid gap-5 px-5 py-5 text-sm sm:px-6">
        <p>
          {frozen
            ? `Frozen by ${FROZEN_BY[frozen.source]}${frozen.byName && frozen.source !== "report" ? ` (${frozen.byName})` : ""} on ${formatDateTime(frozen.at)}${frozen.reason ? `: ${frozen.reason}` : "."}`
            : "Not frozen."}{" "}
          &quot;Settlement accounts only&quot; is {settlementOnly.enabled ? "on" : "off"}.
        </p>
        <div className="grid gap-2">
          <h3 className="text-xs font-medium text-muted-foreground">Settlement accounts</h3>
          {accounts.length === 0 ? (
            <p className="text-muted-foreground">None.</p>
          ) : (
            <ul className="grid gap-2">
              {accounts.map((a) => (
                <li key={a._id} className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{a.accountName}</span>
                  <span className="font-mono text-muted-foreground">{a.accountNumber}</span>
                  <span className="text-muted-foreground">{a.bankName}</span>
                  <Badge variant={a.status === "active" ? "success" : "warning"}>{a.status === "active" ? "Active" : "Being checked"}</Badge>
                </li>
              ))}
            </ul>
          )}
        </div>
        {open.length > 0 && (
          <div className="grid gap-2">
            <h3 className="text-xs font-medium text-muted-foreground">Open requests</h3>
            <ul className="grid gap-2">
              {open.map((r) => (
                <li key={r._id} className="flex flex-wrap items-center gap-2">
                  <Link href={`/security-reviews/${r._id}`} className="font-medium underline-offset-4 hover:underline">
                    {describeRequest(r)}
                  </Link>
                  <RequestStatusBadge status={r.status} />
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </AdminSection>
  )
}
