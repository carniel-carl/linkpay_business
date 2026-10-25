import type { Metadata } from "next"
import Link from "next/link"
import { notFound, redirect } from "next/navigation"
import { ArrowUpRight, Send } from "lucide-react"
import { PageHeader } from "@/components/common/page-header"
import { BeneficiaryMenu, NicknameEdit } from "@/components/payouts/beneficiary-actions"
import { PayoutsLocked } from "@/components/payouts/parts"
import { PayoutsUnavailable } from "@/components/payouts/unavailable"
import { WriteGate } from "@/components/shell/write-gate"
import { NewTransferDialog, type SourceAccount } from "@/components/transfers/new-transfer-dialog"
import { TransferAmount, TransferStatusBadge } from "@/components/transfers/parts"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { fetchAccounts } from "@/lib/accounts"
import type { BeneficiaryDetail, TransferList } from "@/lib/api/types"
import { getBeneficiary, getOverview, getSelected, getTransfers } from "@/lib/data"
import { formatDate, formatTime } from "@/lib/format"
import { can } from "@/lib/permissions"

/** Payments shown per page of a beneficiary's history. */
const HISTORY_PAGE = 10

export async function generateMetadata({ params }: PageProps<"/beneficiaries/[id]">): Promise<Metadata> {
  const beneficiary = await getBeneficiary((await params).id)
  return { title: beneficiary ? (beneficiary.nickname ?? beneficiary.accountName) : "Beneficiary" }
}

/**
 * One saved beneficiary: the account as the bank confirmed it, the nickname, "Pay" (Send money with them chosen),
 * the payout lists that pay them, and the payments made to them (GET /api/transfers?beneficiary=).
 */
export default async function BeneficiaryPage({ params, searchParams }: PageProps<"/beneficiaries/[id]">) {
  const { id } = await params
  const overview = await getOverview()
  if (!overview || overview.business.status !== "approved") redirect("/beneficiaries")
  if (!can(overview, "accounts.view")) return <PayoutsLocked title="Beneficiaries" />

  const raw = (await searchParams).page
  const page = Math.max(1, Math.trunc(Number(Array.isArray(raw) ? raw[0] : raw)) || 1)
  // Paying, renaming and deleting need the right to prepare transfers.
  const canManage = can(overview, "transfers.create")
  const history = new URLSearchParams({ beneficiary: id, skip: String((page - 1) * HISTORY_PAGE), take: String(HISTORY_PAGE) })
  const [beneficiary, payments, accounts, selected] = await Promise.all([
    getBeneficiary(id),
    getTransfers(history),
    canManage ? fetchAccounts() : null,
    getSelected(),
  ])
  if (!beneficiary) notFound()

  // Accounts the member can pay from: their branches', with balances.
  const sources: SourceAccount[] =
    accounts?.state === "ready" ? accounts.accounts.filter((a): a is SourceAccount => typeof a.branch === "object" && !!a.branch) : []
  const defaultBranchId = selected && sources.some((s) => s.branch._id === selected._id) ? selected._id : undefined
  const name = beneficiary.nickname ?? beneficiary.accountName

  return (
    <>
      <PageHeader
        back={{ href: "/beneficiaries", label: "Beneficiaries" }}
        title={
          <span className="flex flex-wrap items-center gap-x-4 gap-y-2">
            {name}
            {beneficiary.onLinkPay && (
              <span className="rounded-md bg-brand-subtle px-2 py-1 font-sans text-xs font-medium tracking-normal text-primary">On LinkPay</span>
            )}
          </span>
        }
        description={
          <>
            {beneficiary.nickname ? `${beneficiary.accountName}, ` : ""}
            {beneficiary.bankName ?? "Bank"} <span className="font-mono">{beneficiary.accountNumber}</span>
          </>
        }
        actions={
          canManage && (
            <>
              {/* Disabled, with the reason, while the business is suspended. */}
              {sources.length > 0 && (
                <WriteGate>
                  <NewTransferDialog accounts={sources} defaultBranchId={defaultBranchId} beneficiary={beneficiary}>
                    <Button>
                      <Send data-icon="inline-start" aria-hidden />
                      Pay
                    </Button>
                  </NewTransferDialog>
                </WriteGate>
              )}
              {/* The menu opens either way; its items are dimmed while suspended (`write`). */}
              <BeneficiaryMenu beneficiary={beneficiary} />
            </>
          )
        }
      />
      <div className="grid min-w-0 grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="grid min-w-0 gap-6 xl:order-last xl:sticky xl:top-24">
          <AccountCard beneficiary={beneficiary} canManage={canManage} />
          <ListsCard beneficiary={beneficiary} />
        </div>
        {payments.ok ? (
          <section aria-labelledby="payments-title" className="surface grid min-w-0 overflow-hidden">
            <div className="grid gap-1 p-5 sm:p-6">
              <h2 id="payments-title" className="type-display text-xl">
                Payments
              </h2>
              <p className="text-sm text-muted-foreground">Transfers to {name}&apos;s account, newest first, including any sent before it was saved. Open one to see it in Transfers.</p>
            </div>
            <History data={payments.data} page={page} beneficiaryId={beneficiary._id} />
          </section>
        ) : (
          <PayoutsUnavailable what="payments" />
        )}
      </div>
    </>
  )
}

function AccountCard({ beneficiary: b, canManage }: { beneficiary: BeneficiaryDetail; canManage: boolean }) {
  const rows: [string, React.ReactNode][] = [
    ["Name at the bank", <span key="n" className="font-medium">{b.accountName}</span>],
    [
      "Nickname",
      <span key="k" className="flex items-start justify-between gap-2">
        {b.nickname ?? <span className="text-muted-foreground">None</span>}
        {canManage && <NicknameEdit beneficiary={b} />}
      </span>,
    ],
    ["Bank", b.bankName ?? <span key="b" className="text-muted-foreground">Not given</span>],
    ["Account number", <span key="a" className="font-mono">{b.accountNumber}</span>],
    ["Last paid", b.lastPaidAt ? formatDate(b.lastPaidAt) : <span key="l" className="text-muted-foreground">Not yet</span>],
  ]
  return (
    <section aria-labelledby="account-title" className="surface grid min-w-0 gap-4 p-6 [&>*]:min-w-0">
      <h2 id="account-title" className="text-sm font-medium">
        Account
      </h2>
      <dl className="grid gap-3 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="grid grid-cols-[8.5rem_minmax(0,1fr)] gap-3">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 break-words">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="border-t pt-4 text-xs text-muted-foreground">
        Saved {formatDate(b.createdAt)}
        {b.createdBy ? ` by ${b.createdBy.name}` : ""}. {b.onLinkPay ? "This account belongs to another business on LinkPay. " : ""}Only the
        nickname can change. To pay a different account, save it as a new beneficiary.
      </p>
    </section>
  )
}

function ListsCard({ beneficiary: b }: { beneficiary: BeneficiaryDetail }) {
  return (
    <section aria-labelledby="lists-title" className="surface grid min-w-0 gap-3 p-6">
      <h2 id="lists-title" className="text-sm font-medium">
        Payout lists
      </h2>
      {b.payoutLists.length ? (
        <ul className="grid gap-2 text-sm">
          {b.payoutLists.map((l) => (
            <li key={l._id}>
              <Link href={`/payout-lists/${l._id}`} className="font-medium break-words underline-offset-4 hover:text-primary hover:underline">
                {l.title}
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">
          Not on a payout list.{" "}
          <Link href="/payout-lists" className="underline underline-offset-4 hover:text-foreground">
            Payout lists
          </Link>{" "}
          pay several people together.
        </p>
      )}
    </section>
  )
}

/** The payments, a page at a time (?page=), each opening its transfer in Transfers. */
function History({ data, page, beneficiaryId }: { data: TransferList; page: number; beneficiaryId: string }) {
  if (data.total === 0) {
    return (
      <Empty className="min-h-64 border-0 border-t">
        <EmptyHeader>
          <EmptyMedia variant="icon" className="bg-pop-subtle text-foreground">
            <ArrowUpRight aria-hidden />
          </EmptyMedia>
          <EmptyTitle className="type-display text-2xl">No payments yet</EmptyTitle>
          <EmptyDescription>Payments to this beneficiary show here once someone on your team sends one.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  const first = (page - 1) * HISTORY_PAGE + 1
  const last = Math.min(data.total, first + data.items.length - 1)
  const href = (p: number) => (p > 1 ? `/beneficiaries/${beneficiaryId}?page=${p}` : `/beneficiaries/${beneficiaryId}`)
  return (
    <>
      {data.items.length === 0 ? (
        <p className="border-t px-5 py-8 text-sm text-muted-foreground sm:px-6">
          No payments on this page.{" "}
          <Link href={href(1)} className="underline underline-offset-4 hover:text-foreground">
            Go to the newest
          </Link>
          .
        </p>
      ) : (
        <ul className="divide-y border-t">
          {data.items.map((t) => (
            <li key={t._id}>
              <Link
                href={`/transfers?transfer=${t._id}`}
                className="flex items-start gap-4 px-5 py-3.5 transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none sm:px-6"
              >
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <span className="text-sm font-medium">
                    {formatDate(t.createdAt)} <span className="font-normal text-muted-foreground">{formatTime(t.createdAt)}</span>
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {[t.branch ? `From ${t.branch.name}` : null, t.narration, t.createdBy ? `by ${t.createdBy.name}` : null].filter(Boolean).join(" · ")}
                  </span>
                </span>
                <span className="grid shrink-0 justify-items-end gap-1">
                  <TransferAmount kobo={t.amountKobo} />
                  <TransferStatusBadge status={t.status} />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {data.total > HISTORY_PAGE && (
        <nav aria-label="Payment pages" className="flex flex-wrap items-center justify-between gap-3 border-t px-5 py-3 text-sm sm:px-6">
          <span className="text-muted-foreground">
            {data.items.length ? (
              <>
                <span className="figure">{first}</span> to <span className="figure">{last}</span> of <span className="figure">{data.total}</span>
              </>
            ) : (
              <>
                <span className="figure">{data.total}</span> payments
              </>
            )}
          </span>
          <span className="flex gap-2">
            {page > 1 ? (
              <Button variant="outline" size="sm" asChild>
                <Link href={href(page - 1)} scroll={false}>
                  Newer
                </Link>
              </Button>
            ) : (
              <Button variant="outline" size="sm" disabled>
                Newer
              </Button>
            )}
            {page * HISTORY_PAGE < data.total ? (
              <Button variant="outline" size="sm" asChild>
                <Link href={href(page + 1)} scroll={false}>
                  Older
                </Link>
              </Button>
            ) : (
              <Button variant="outline" size="sm" disabled>
                Older
              </Button>
            )}
          </span>
        </nav>
      )}
    </>
  )
}
