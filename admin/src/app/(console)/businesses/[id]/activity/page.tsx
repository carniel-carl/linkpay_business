import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { Clock, KeyRound, ShieldCheck, Smartphone } from "lucide-react"
import { BusinessPayments, BusinessTransfers } from "@/components/activity/flaggable-lists"
import { FlowChart } from "@/components/activity/flow-chart"
import { ListFilters } from "@/components/activity/list-filters"
import { AdminSection } from "@/components/admin/admin-section"
import { BusinessHeader } from "@/components/admin/business-header"
import { Pager } from "@/components/common/url-state"
import { Badge } from "@/components/ui/badge"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { BusinessActivity, BusinessMembers, TransferStatus } from "@/lib/api/types"
import {
  DIRECTION_LABELS,
  one,
  PAGE_SIZE,
  parsePaymentQuery,
  parseTransferQuery,
  TRANSACTION_STATUS_LABELS,
  TRANSFER_KIND_LABELS,
  TRANSFER_STATUS_LABELS,
} from "@/lib/compliance"
import {
  getAdminBusiness,
  getBusinessActivity,
  getBusinessMembers,
  getBusinessTransactions,
  getBusinessTransfers,
  getComplianceRules,
  getStaff,
} from "@/lib/data"
import { formatDate, formatDateTime, formatNaira, timeAgo } from "@/lib/format"
import { requirePermission } from "@/lib/guard"
import { can } from "@/lib/permissions"
import { cn } from "@/lib/utils"

export async function generateMetadata({ params }: PageProps<"/businesses/[id]/activity">): Promise<Metadata> {
  if (!can(await getStaff(), "businesses.view")) return { title: "Activity" }
  const overview = await getAdminBusiness((await params).id)
  return { title: overview ? `${overview.business.name}: activity` : "Business not found" }
}

const VIEWS = { payments: "Payments", transfers: "Transfers", team: "Team" } as const
type View = keyof typeof VIEWS

const lagosToday = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date())

export default async function BusinessActivityPage({ params, searchParams }: PageProps<"/businesses/[id]/activity">) {
  const blocked = (await requirePermission("businesses.view", "Activity")) ?? (await requirePermission("activity.view", "Activity"))
  if (blocked) return blocked
  const { id } = await params
  const raw = await searchParams
  const [overview, staff] = await Promise.all([getAdminBusiness(id), getStaff()])
  if (!overview) notFound()
  const { business } = overview
  const header = <BusinessHeader overview={overview} staff={staff} tab="activity" />

  if (business.status !== "approved") {
    return (
      <>
        {header}
        <Empty className="surface min-h-80 border-0 p-10">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Clock aria-hidden />
            </EmptyMedia>
            <EmptyTitle>No activity before approval</EmptyTitle>
            <EmptyDescription>A business gets its accounts once it&apos;s approved. Payments and transfers show here after that.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    )
  }

  const view: View = (Object.keys(VIEWS) as View[]).find((v) => v === one(raw.view)) ?? "payments"
  const paymentQuery = parsePaymentQuery(raw)
  const transferQuery = parseTransferQuery(raw)
  const canFlag = can(staff, "compliance.manage")
  const [activity, payments, transfers, members, rules] = await Promise.all([
    getBusinessActivity(id),
    view === "payments" ? getBusinessTransactions(id, paymentQuery) : null,
    view === "transfers" ? getBusinessTransfers(id, transferQuery) : null,
    view === "team" ? getBusinessMembers(id) : null,
    canFlag ? getComplianceRules() : null,
  ])
  if (!activity) notFound()
  const flagging = { business: { _id: business._id, name: business.name }, categories: rules?.categories }

  return (
    <>
      {header}
      <div className="stagger grid gap-6">
        <div style={{ "--i": 0 } as React.CSSProperties}>
          <FlowSummary activity={activity} />
        </div>

        <div style={{ "--i": 1 } as React.CSSProperties} className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          <AdminSection
            id="flow"
            title="Last 30 days"
            aside={
              <span className="text-xs text-muted-foreground">
                {activity.lastActivityAt ? `Last payment ${timeAgo(activity.lastActivityAt)}` : "No payments yet"}
              </span>
            }
          >
            <FlowChart daily={activity.daily} today={lagosToday()} />
          </AdminSection>
          <div className="grid gap-6">
            <Balances accounts={activity.accounts} />
            <TransferCounts counts={activity.transfers.last30d} />
          </div>
        </div>

        <section style={{ "--i": 2 } as React.CSSProperties} aria-label="Records" className="surface overflow-hidden">
          <nav aria-label="Records" className="overflow-x-auto border-b px-4 sm:px-6">
            <ul className="flex w-max min-w-full gap-1">
              {(Object.keys(VIEWS) as View[]).map((v) => (
                <li key={v}>
                  <Link
                    href={v === "payments" ? `/businesses/${id}/activity` : `/businesses/${id}/activity?view=${v}`}
                    scroll={false}
                    aria-current={v === view ? "page" : undefined}
                    className={cn(
                      "-mb-px inline-flex h-12 items-center border-b-2 px-3 text-sm whitespace-nowrap transition-colors duration-150",
                      "rounded-t-md focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                      v === view ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {VIEWS[v]}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>

          {payments && (
            <>
              <ListFilters
                id="payments"
                search={{ label: "Search payments", placeholder: "Name, account, narration or reference" }}
                selects={[
                  { key: "direction", label: "Direction", any: "In and out", options: entries(DIRECTION_LABELS) },
                  { key: "status", label: "Status", any: "Any status", options: entries(TRANSACTION_STATUS_LABELS) },
                ]}
                amount
                dates
              />
              <div className="border-t">
                <BusinessPayments
                  items={payments.items}
                  filtered={hasAny(raw, ["direction", "status", "min", "from", "to", "q"])}
                  {...flagging}
                />
              </div>
              <Pager total={payments.total} page={paymentQuery.page} pageSize={PAGE_SIZE} noun="payments" />
            </>
          )}

          {transfers && (
            <>
              <ListFilters
                id="transfers"
                search={{ label: "Search transfers", placeholder: "Recipient, account, narration or reference" }}
                selects={[
                  { key: "status", label: "Status", any: "Any status", options: entries(TRANSFER_STATUS_LABELS) },
                  { key: "kind", label: "Type", any: "Any type", options: entries(TRANSFER_KIND_LABELS) },
                ]}
                amount
                dates
              />
              <div className="border-t">
                <BusinessTransfers
                  items={transfers.items}
                  filtered={hasAny(raw, ["status", "kind", "min", "from", "to", "q"])}
                  {...flagging}
                />
              </div>
              <Pager total={transfers.total} page={transferQuery.page} pageSize={PAGE_SIZE} noun="transfers" />
            </>
          )}

          {members && <Team data={members} />}
        </section>
      </div>
    </>
  )
}

const entries = (labels: Record<string, string>) => Object.entries(labels).map(([value, label]) => ({ value, label }))
const hasAny = (raw: Record<string, unknown>, keys: string[]) => keys.some((k) => raw[k] !== undefined && raw[k] !== "")

function FlowSummary({ activity }: { activity: BusinessActivity }) {
  const periods = [
    { key: "last24h", label: "24 hours" },
    { key: "last7d", label: "7 days" },
    { key: "last30d", label: "30 days" },
  ] as const
  const rows = [
    { label: "Money in", flows: activity.moneyIn, swatch: "bg-flow-in", note: "Successful payments received" },
    { label: "Money out", flows: activity.moneyOut, swatch: "bg-flow-out", note: "Payouts the bank partner accepted" },
  ]
  const facts = [
    { label: "Payers, 30 days", value: activity.counterparties.payers30d },
    { label: "Recipients, 30 days", value: activity.counterparties.recipients30d },
    { label: "Team members", value: activity.team.members },
  ]

  return (
    <div className="grid overflow-hidden surface lg:grid-cols-[minmax(0,1fr)_16rem]">
      <table className="w-full text-sm">
        <caption className="sr-only">Money in and out of {activity.business.name}</caption>
        <thead>
          <tr className="border-b">
            <td className="p-4 sm:px-6" />
            {periods.map((p) => (
              <th key={p.key} scope="col" className="px-3 py-3 text-right text-xs font-medium text-muted-foreground sm:px-6">
                {p.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className="border-b last:border-0">
              <th scope="row" className="p-4 text-left font-normal sm:px-6">
                <span className="flex items-center gap-2 font-medium">
                  <span aria-hidden className={cn("size-2.5 rounded-sm", r.swatch)} />
                  {r.label}
                </span>
                <span className="hidden text-xs text-muted-foreground sm:block">{r.note}</span>
              </th>
              {periods.map((p) => (
                <td key={p.key} className="px-3 py-4 text-right sm:px-6">
                  <span className="type-display figure block text-lg sm:text-2xl">{formatNaira(r.flows[p.key].kobo)}</span>
                  <span className="text-xs text-muted-foreground figure">
                    {r.flows[p.key].count} {r.flows[p.key].count === 1 ? "payment" : "payments"}
                  </span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <dl className="grid content-center gap-3 border-t p-4 text-sm sm:px-6 lg:border-t-0 lg:border-l">
        {facts.map((f) => (
          <div key={f.label} className="flex items-baseline justify-between gap-3">
            <dt className="text-muted-foreground">{f.label}</dt>
            <dd className="figure font-medium">{f.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

function Balances({ accounts }: { accounts: BusinessActivity["accounts"] }) {
  return (
    <AdminSection id="balances" title="Balances" flush aside={<span className="text-xs text-muted-foreground">Live from the bank partner</span>}>
      {accounts.length === 0 ? (
        <p className="p-5 text-sm text-muted-foreground sm:px-6">No accounts yet.</p>
      ) : (
        <ul className="divide-y">
          {accounts.map((a) => (
            <li key={a._id} className="flex items-center justify-between gap-4 px-5 py-3 sm:px-6">
              <div className="grid min-w-0 gap-0.5">
                <span className="truncate font-medium">{a.branch?.name ?? a.accountName ?? "Account"}</span>
                <span className="font-mono text-xs text-muted-foreground">
                  {a.accountNumber}
                  {a.bankName && `, ${a.bankName}`}
                </span>
              </div>
              {a.balanceKobo === null ? (
                <span className="text-right text-xs text-muted-foreground">Couldn&apos;t load</span>
              ) : (
                <span className="figure font-medium whitespace-nowrap">{formatNaira(a.balanceKobo)}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </AdminSection>
  )
}

const COUNT_ORDER: TransferStatus[] = ["success", "processing", "pending_approval", "failed", "rejected", "cancelled"]

function TransferCounts({ counts }: { counts: BusinessActivity["transfers"]["last30d"] }) {
  const total = COUNT_ORDER.reduce((s, k) => s + (counts[k]?.count ?? 0), 0)
  return (
    <AdminSection id="transfers-30d" title="Transfers, 30 days" flush aside={<span className="figure text-xs text-muted-foreground">{total} started</span>}>
      <dl className="divide-y text-sm">
        {COUNT_ORDER.filter((k) => counts[k]?.count || k === "success").map((k) => (
          <div key={k} className="flex items-baseline justify-between gap-3 px-5 py-2.5 sm:px-6">
            <dt className={cn(k === "failed" && counts[k].count > 0 && "text-destructive")}>{TRANSFER_STATUS_LABELS[k]}</dt>
            <dd className="figure">
              <span className="font-medium">{counts[k]?.count ?? 0}</span>
              <span className="ml-2 text-muted-foreground">{formatNaira(counts[k]?.kobo ?? 0)}</span>
            </dd>
          </div>
        ))}
      </dl>
    </AdminSection>
  )
}

function Team({ data }: { data: BusinessMembers }) {
  return (
    <>
      <Table className="min-w-180">
        <caption className="sr-only">Team members, their last sign-in and devices</caption>
        <TableHeader className="bg-muted/60">
          <TableRow className="hover:bg-transparent">
            <TableHead scope="col" className="h-10 pl-4 text-xs text-muted-foreground sm:pl-6">Member</TableHead>
            <TableHead scope="col" className="h-10 text-xs text-muted-foreground">Role</TableHead>
            <TableHead scope="col" className="h-10 text-xs text-muted-foreground">Last sign-in</TableHead>
            <TableHead scope="col" className="h-10 text-xs text-muted-foreground">Security</TableHead>
            <TableHead scope="col" className="h-10 pr-4 text-xs text-muted-foreground sm:pr-6">Joined</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.members.map((m) => (
            <TableRow key={m.user._id}>
              <TableCell className="py-3 pl-4 sm:pl-6">
                <div className="grid gap-0.5">
                  <span className="font-medium">{m.user.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {m.user.email}
                    {!m.user.emailVerified && " (not verified)"}
                  </span>
                </div>
              </TableCell>
              <TableCell className="py-3">
                <div className="grid gap-1">
                  <Badge variant={m.role === "owner" ? "default" : "muted"}>{m.roleLabel}</Badge>
                  <span className="text-xs text-muted-foreground">
                    {m.branches.length ? m.branches.map((b) => b.name ?? "Removed branch").join(", ") : "All branches"}
                  </span>
                </div>
              </TableCell>
              <TableCell className="py-3">
                {m.user.lastSignInAt ? (
                  <div className="grid gap-0.5">
                    <span title={formatDateTime(m.user.lastSignInAt)}>{timeAgo(m.user.lastSignInAt)}</span>
                    {m.user.lastSignInIp && <span className="font-mono text-xs text-muted-foreground">{m.user.lastSignInIp}</span>}
                  </div>
                ) : (
                  <span className="text-muted-foreground">Not recorded</span>
                )}
              </TableCell>
              <TableCell className="py-3">
                <div className="grid gap-1 text-xs">
                  <span className={cn("inline-flex items-center gap-1.5", !m.user.twoFactor && "text-warning-foreground dark:text-warning")}>
                    {m.user.twoFactor ? <ShieldCheck className="size-3.5" aria-hidden /> : <KeyRound className="size-3.5" aria-hidden />}
                    {m.user.twoFactor === "totp" ? "Authenticator app" : m.user.twoFactor === "email" ? "Email codes" : "No two-step"}
                  </span>
                  <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                    <Smartphone className="size-3.5" aria-hidden />
                    {m.activeDevices} signed-in {m.activeDevices === 1 ? "phone" : "phones"}
                  </span>
                </div>
              </TableCell>
              <TableCell className="py-3 pr-4 figure sm:pr-6">{formatDate(m.joinedAt)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {data.invites.length > 0 && (
        <div className="border-t px-4 py-4 sm:px-6">
          <h3 className="text-sm font-medium">Open invites</h3>
          <ul className="mt-2 grid gap-1.5 text-sm">
            {data.invites.map((i) => (
              <li key={i._id} className="flex flex-wrap items-baseline gap-x-2">
                <span>{i.email}</span>
                <span className="text-xs text-muted-foreground">
                  {i.roleLabel}, sent {timeAgo(i.createdAt)}, expires {formatDate(i.expiresAt)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  )
}
