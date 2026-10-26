import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { Phone } from "lucide-react"
import { AdminSection } from "@/components/admin/admin-section"
import { PageHeader } from "@/components/common/page-header"
import { ClearHoldButton, FreezeButtons, RequestStatusBadge, ReviewActions, RiskBadge } from "@/components/security/security-parts"
import { Badge } from "@/components/ui/badge"
import type { SecurityRequestDetail } from "@/lib/api/types"
import { getSecurityRequest } from "@/lib/data"
import { formatDateTime, timeAgo } from "@/lib/format"
import { requirePermission } from "@/lib/guard"
import { describeRequest } from "@/lib/security"

export const metadata: Metadata = { title: "Security review" }

export default async function SecurityReviewPage({ params }: PageProps<"/security-reviews/[id]">) {
  const blocked = await requirePermission("security.review", "Security review")
  if (blocked) return blocked
  const { id } = await params
  const r = await getSecurityRequest(id)
  if (!r) notFound()
  const what = describeRequest(r)
  const s = r.signals

  return (
    <>
      <PageHeader
        title={r.business?.name ?? "Security review"}
        description={what}
        actions={r.status === "pending" && <ReviewActions requestId={r._id} what={what.charAt(0).toLowerCase() + what.slice(1)} availableAt={r.availableAt} />}
      />
      <div className="stagger grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="grid min-w-0 gap-6" style={{ "--i": 0 } as React.CSSProperties}>
          <AdminSection id="request" title="What's asked" flush aside={<RequestStatusBadge status={r.status} />}>
            <dl className="grid gap-4 px-5 py-5 text-sm sm:grid-cols-2 sm:px-6">
              {r.settlementAccount && (
                <>
                  <Item label="Account name" value={r.settlementAccount.accountName} />
                  <Item label="Account" value={<span className="font-mono">{r.settlementAccount.accountNumber}</span>} hint={r.settlementAccount.bankName ?? undefined} />
                  <Item
                    label="Name check"
                    value={
                      <span className="flex flex-wrap items-center gap-2">
                        <Badge variant={r.settlementAccount.nameCheck.result === "match" ? "success" : "warning"}>
                          {r.settlementAccount.nameCheck.result === "match" ? "Matches" : "Partly matches"}
                        </Badge>
                        <span className="figure text-muted-foreground">{Math.round(r.settlementAccount.nameCheck.score * 100)}%</span>
                      </span>
                    }
                    hint={`Against ${r.settlementAccount.nameCheck.matchedTo === "business" ? "the business name" : "a principal"}: ${r.settlementAccount.nameCheck.matchedName}${r.settlementAccount.nameCheck.note ? `. ${r.settlementAccount.nameCheck.note}` : ""}`}
                  />
                </>
              )}
              <Item label="Asked" value={formatDateTime(r.createdAt)} hint={timeAgo(r.createdAt)} />
              <Item label="Cooling-off ends" value={formatDateTime(r.availableAt)} hint="It can't take effect before this, whatever you decide." />
              <Item
                label="Asked by"
                value={r.requestedBy?.name ?? "Unknown"}
                hint={[r.requestedBy?.email, s.requester?.role, s.requester?.twoFactor ? `two-step by ${s.requester.twoFactor === "totp" ? "app" : "email"}` : "no two-step"].filter(Boolean).join(", ")}
              />
              <Item label="From" value={<span className="font-mono">{r.ip ?? "unknown"}</span>} hint={r.userAgent ?? undefined} />
              {s.requester?.lastSignInIp && <Item label="Last sign-in" value={<span className="font-mono">{s.requester.lastSignInIp}</span>} hint={formatDateTime(s.requester.lastSignInAt ?? undefined)} />}
            </dl>
            {(r.review || r.cancellation) && (
              <div className="border-t px-5 py-4 text-sm sm:px-6">
                {r.review && (
                  <p>
                    {r.review.decision === "approved" ? "Approved" : "Rejected"} by {r.review.byName} on {formatDateTime(r.review.at)}
                    {r.review.callbackConfirmed ? " after a call back" : ""}: {r.review.note}
                  </p>
                )}
                {r.cancellation && (
                  <p>
                    Cancelled {r.cancellation.by === "report" ? `by a "This wasn't me" report from ${r.cancellation.byName}` : `by ${r.cancellation.byName}`} on{" "}
                    {formatDateTime(r.cancellation.at)}
                    {r.cancellation.reason ? `: ${r.cancellation.reason}` : "."}
                  </p>
                )}
              </div>
            )}
          </AdminSection>

          <AdminSection id="risk" title="Risk" flush aside={<RiskBadge risk={s.risk} />}>
            {s.reasons?.length ? (
              <ul className="grid gap-2 px-5 py-5 text-sm sm:px-6">
                {s.reasons.map((reason) => (
                  <li key={reason} className="flex gap-2">
                    <span aria-hidden className="mt-2 size-1.5 shrink-0 rounded-full bg-muted-foreground" />
                    {reason}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-5 py-5 text-sm text-muted-foreground sm:px-6">Nothing unusual found.</p>
            )}
            <dl className="grid gap-4 border-t px-5 py-5 text-sm sm:grid-cols-3 sm:px-6">
              <Item label="First settlement account" value={s.firstEver ? "Yes" : "No"} />
              <Item label="Paid this account before" value={`${s.paidBefore ?? 0} times`} />
              <Item label="Changes in 30 days" value={String(s.settlementChanges30d ?? 0)} />
              <Item label="New phones (7 days)" value={String(s.newDevices7d ?? 0)} />
              <Item label="Wrong codes (7 days)" value={String(s.failedCodes7d ?? 0)} />
              <Item label="Two-step changed" value={s.twoFactorChangedAt ? formatDateTime(s.twoFactorChangedAt) : "Not in 30 days"} />
              {!!s.sharedWith?.length && (
                <Item
                  label="Also a settlement account of"
                  value={
                    <span className="flex flex-wrap gap-2">
                      {s.sharedWith.map((b) => (
                        <Link key={b._id} href={`/businesses/${b._id}`} className="font-medium underline-offset-4 hover:underline">
                          {b.name}
                        </Link>
                      ))}
                    </span>
                  }
                />
              )}
            </dl>
          </AdminSection>
        </div>

        <div className="grid min-w-0 gap-6" style={{ "--i": 1 } as React.CSSProperties}>
          <Contacts request={r} />

          {r.business && (
            <AdminSection id="money-out" title="Money out" flush>
              <div className="grid gap-4 px-5 py-5 sm:px-6">
                <p className="text-sm text-muted-foreground">
                  {r.business.frozen ? "Frozen: nothing can leave this business." : "Not frozen."} Freeze it if the call back didn&apos;t check out.
                </p>
                <div className="flex flex-wrap gap-2">
                  <FreezeButtons businessId={r.business._id} frozen={r.business.frozen} />
                  {r.requestedBy && <ClearHoldButton userId={r.requestedBy._id} name={r.requestedBy.name} />}
                </div>
                <Link href={`/businesses/${r.business._id}/compliance`} className="text-sm font-medium underline-offset-4 hover:underline">
                  Open the business&apos;s compliance tab
                </Link>
              </div>
            </AdminSection>
          )}

          <AdminSection id="accounts" title="Its settlement accounts" flush>
            {r.settlementAccounts.length === 0 ? (
              <p className="px-5 py-4 text-sm text-muted-foreground sm:px-6">None.</p>
            ) : (
              <ul className="divide-y">
                {r.settlementAccounts.map((a) => (
                  <li key={a._id} className="grid gap-0.5 px-5 py-3 sm:px-6">
                    <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      {a.accountName}
                      <Badge variant={a.status === "active" ? "success" : a.status === "pending" ? "warning" : "muted"}>{a.status}</Badge>
                    </span>
                    <span className="text-xs text-muted-foreground">
                      <span className="font-mono">{a.accountNumber}</span>, {a.bankName ?? "bank"}, added {formatDateTime(a.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </AdminSection>

          <AdminSection id="events" title="Security activity" flush>
            {r.events.length === 0 ? (
              <p className="px-5 py-4 text-sm text-muted-foreground sm:px-6">Nothing yet.</p>
            ) : (
              <ul className="divide-y">
                {r.events.map((e) => (
                  <li key={e._id} className="grid gap-0.5 px-5 py-3 sm:px-6">
                    <span className="text-sm">{e.summary}</span>
                    <span className="text-xs text-muted-foreground">
                      {formatDateTime(e.createdAt)}
                      {e.ip ? `, from ${e.ip}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </AdminSection>
        </div>
      </div>
    </>
  )
}

function Item({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="grid content-start gap-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{value}</dd>
      {hint && <dd className="text-xs break-words text-muted-foreground">{hint}</dd>}
    </div>
  )
}

/** The numbers to call back on: from the business's verification only. */
function Contacts({ request: r }: { request: SecurityRequestDetail }) {
  const c = r.contacts
  const people = c?.people.filter((p) => p.phone || p.email) ?? []
  return (
    <AdminSection id="contacts" title="Call back on" flush>
      <p className="px-5 pt-4 text-xs text-muted-foreground sm:px-6">
        From the business&apos;s verification. Never use a number the requester gives you, in an email or on the phone.
      </p>
      <ul className="divide-y">
        {c?.businessPhone && <Contact name="Business line" phone={c.businessPhone} email={c.businessEmail} />}
        {people.map((p) => (
          <Contact key={p.fullName} name={p.fullName} detail={p.roles.join(", ")} phone={p.phone} email={p.email} />
        ))}
        {!c?.businessPhone && people.length === 0 && (
          <li className="px-5 py-4 text-sm text-destructive sm:px-6">No phone numbers on file. Don&apos;t approve without another way to confirm.</li>
        )}
      </ul>
    </AdminSection>
  )
}

function Contact({ name, detail, phone, email }: { name: string; detail?: string; phone: string | null; email: string | null }) {
  return (
    <li className="grid gap-0.5 px-5 py-3 sm:px-6">
      <span className="text-sm font-medium">
        {name}
        {detail ? <span className="font-normal text-muted-foreground">, {detail}</span> : null}
      </span>
      {phone && (
        <a href={`tel:${phone}`} className="flex items-center gap-1.5 font-mono text-sm underline-offset-4 hover:underline">
          <Phone className="size-3.5" aria-hidden />
          {phone}
        </a>
      )}
      {email && <span className="text-xs text-muted-foreground">{email}</span>}
    </li>
  )
}
