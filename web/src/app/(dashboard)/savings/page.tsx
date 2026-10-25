import type { Metadata } from "next"
import Link from "next/link"
import { Lock, PiggyBank, Plus } from "lucide-react"
import { PageHeader } from "@/components/common/page-header"
import { FeaturePlaceholder } from "@/components/dashboard/feature-placeholder"
import { PocketFormDialog, type PocketBranch } from "@/components/savings/pocket-form-dialog"
import { SafelockFormDialog } from "@/components/savings/safelock-form-dialog"
import { SafelockView } from "@/components/savings/safelock-view"
import { SavingsView } from "@/components/savings/savings-view"
import { WriteGate } from "@/components/shell/write-gate"
import { TransactionsUnavailable } from "@/components/transactions/transactions-unavailable"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { fetchAccounts } from "@/lib/accounts"
import { getOverview, getPocket, getPockets, getSafelock, getSafelockLimits, getSafelocks, getSelected } from "@/lib/data"
import { can } from "@/lib/permissions"
import { parseSavingsQuery, type SavingsQuery } from "@/lib/savings"
import { cn } from "@/lib/utils"

export const metadata: Metadata = { title: "Savings" }

export default async function SavingsPage({ searchParams }: PageProps<"/savings">) {
  const overview = await getOverview()
  if (!overview || overview.business.status !== "approved") {
    return (
      <FeaturePlaceholder
        title="Savings"
        icon={PiggyBank}
        summary="Set money aside for tax, payroll and rent."
        detail="Keep money for what's coming apart from what you spend, with targets and automatic saving from every payment in."
      />
    )
  }
  if (!can(overview, "accounts.view")) {
    return (
      <>
        <PageHeader title="Savings" description="Money set aside in your accounts." />
        <Empty className="surface min-h-80 border-0 p-10">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Lock aria-hidden />
            </EmptyMedia>
            <EmptyTitle>Savings aren&apos;t part of your role</EmptyTitle>
            <EmptyDescription>Ask the business owner or an admin if you need to see or manage savings.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    )
  }

  const query = parseSavingsQuery(await searchParams)
  const selected = await getSelected()
  const branches = overview.branches ?? []
  const canManage = can(overview, "savings.manage")
  const safelock = query.view === "safelock"

  // Only the view on screen is loaded.
  const [active, closed, locked, released, limits, accounts, linkedPocket, linkedLock] = await Promise.all([
    safelock ? null : getPockets("active", selected?._id),
    !safelock && query.status === "closed" ? getPockets("closed", selected?._id) : null,
    safelock ? getSafelocks("locked", selected?._id) : null,
    safelock && query.lockStatus === "released" ? getSafelocks("released", selected?._id) : null,
    safelock && canManage ? getSafelockLimits() : null,
    fetchAccounts(selected?._id),
    !safelock && query.pocket ? getPocket(query.pocket) : null,
    safelock && query.safelock ? getSafelock(query.safelock) : null,
  ])

  // Branches whose account is open, with what each can still save (available balance).
  const ready: PocketBranch[] =
    accounts.state === "ready"
      ? accounts.accounts.flatMap((a) =>
          typeof a.branch === "object" && a.branch
            ? [{ _id: a.branch._id, name: a.branch.name, availableKobo: a.balance?.availableKobo ?? a.balance?.amountKobo ?? null }]
            : [],
        )
      : []

  // New Safelocks can go on any ready branch still under the per-branch limit.
  const lockable =
    locked?.ok && limits?.ok
      ? ready.filter((b) => locked.data.items.filter((s) => s.branch?._id === b._id).length < limits.data.maxPerBranch)
      : []

  // Disabled, with the reason, while the business is suspended (so are the moves in a pocket's sheet).
  const newPocket = canManage && ready.length > 0 && (
    <WriteGate>
      <PocketFormDialog branches={ready} defaultBranchId={selected?._id}>
        <Button>
          <Plus data-icon="inline-start" aria-hidden />
          New pocket
        </Button>
      </PocketFormDialog>
    </WriteGate>
  )
  const newSafelock = canManage && limits?.ok && lockable.length > 0 && (
    <WriteGate>
      <SafelockFormDialog branches={lockable} limits={limits.data} defaultBranchId={selected?._id}>
        <Button>
          <Lock data-icon="inline-start" aria-hidden />
          New Safelock
        </Button>
      </SafelockFormDialog>
    </WriteGate>
  )

  const header = (
    <PageHeader
      title={selected && branches.length > 1 ? `Savings, ${selected.name}` : "Savings"}
      description={
        <div className="grid gap-5">
          <span>
            {selected && branches.length > 1 ? `Showing ${selected.name}. ` : ""}
            {safelock
              ? "Lock money away until a date you choose. Nobody can spend or take it out early, and it comes back by itself on the day."
              : "Set money aside for tax, payroll or rent. It stays in your account, out of what transfers can spend, and comes back whenever you need it."}
          </span>
          <ViewTabs current={query.view} />
        </div>
      }
      actions={safelock ? newSafelock : newPocket}
    />
  )

  const failed = safelock ? !locked?.ok || (released && !released.ok) : !active?.ok || (closed && !closed.ok)
  if (failed) {
    return (
      <>
        {header}
        <TransactionsUnavailable />
      </>
    )
  }

  return (
    <>
      {header}
      {safelock ? (
        <SafelockView
          locked={locked!.ok ? locked!.data : { items: [], lockedKobo: 0, currency: "NGN" }}
          released={released?.ok ? released.data.items : null}
          query={query}
          linked={linkedLock?.ok ? linkedLock.data : null}
          branches={lockable}
          limits={limits?.ok ? limits.data : null}
          canManage={canManage}
          showBranch={!selected && branches.length > 1}
          newSafelock={newSafelock}
        />
      ) : (
        <SavingsView
          active={active!.ok ? active!.data : { items: [], savedKobo: 0, currency: "NGN" }}
          closed={closed?.ok ? closed.data.items : null}
          query={query}
          linked={linkedPocket?.ok ? linkedPocket.data : null}
          branches={ready}
          canManage={canManage}
          showBranch={!selected && branches.length > 1}
          newPocket={newPocket}
        />
      )}
    </>
  )
}

/** Pockets or Safelock, as pill tabs on the band (real links, so the back button works). */
function ViewTabs({ current }: { current: SavingsQuery["view"] }) {
  const tabs = [
    { key: "pockets", label: "Pockets", href: "/savings" },
    { key: "safelock", label: "Safelock", href: "/savings?view=safelock" },
  ] as const
  return (
    <nav aria-label="Savings">
      <ul className="flex w-fit gap-1 rounded-full bg-brand-surface-foreground/[0.07] p-1">
        {tabs.map((t) => {
          const active = t.key === current
          return (
            <li key={t.key}>
              <Link
                href={t.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-flex h-8 items-center rounded-full px-4 text-sm transition-colors duration-150 outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                  active ? "bg-card font-medium text-foreground shadow-sm" : "text-brand-surface-muted hover:text-brand-surface-foreground",
                )}
              >
                {t.label}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
