"use client"

import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { PiggyBank, Plus } from "lucide-react"
import { BalanceAmount } from "@/components/accounts/balance-visibility"
import { NavTabs } from "@/components/common/nav-tabs"
import { useReadOnly } from "@/components/shell/write-gate"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import type { Pocket, PocketList } from "@/lib/api/types"
import { formatDate, formatNaira } from "@/lib/format"
import { describeAutoSave, MAX_POCKETS_PER_BRANCH, type SavingsQuery } from "@/lib/savings"
import { cn } from "@/lib/utils"
import { PocketFormDialog, type PocketBranch } from "./pocket-form-dialog"
import { PocketSheet } from "./pocket-sheet"
import { PocketProgress, PocketTags, PocketTile, TargetLine } from "./parts"

type Props = {
  active: PocketList
  /** Closed pockets, when that tab is showing. */
  closed: Pocket[] | null
  query: SavingsQuery
  /** A pocket opened by link (?pocket=) that isn't in the lists on screen. */
  linked: Pocket | null
  branches: PocketBranch[]
  canManage: boolean
  showBranch: boolean
  newPocket: React.ReactNode
}

function href(status: SavingsQuery["status"], pocket?: string) {
  const params = new URLSearchParams()
  if (status === "closed") params.set("status", "closed")
  if (pocket) params.set("pocket", pocket)
  const qs = params.toString()
  return qs ? `?${qs}` : "?"
}

export function SavingsView({ active, closed, query, linked, branches, canManage, showBranch, newPocket }: Props) {
  const router = useRouter()
  const pathname = usePathname()
  // Suspended: the header's New pocket shows disabled, so the tile at the end of the list goes.
  const { readOnly } = useReadOnly()
  const pockets = query.status === "closed" ? (closed ?? []) : active.items
  const open = query.pocket
    ? (active.items.find((p) => p._id === query.pocket) ?? closed?.find((p) => p._id === query.pocket) ?? linked)
    : null
  const branchCount = new Set(active.items.map((p) => p.branch?._id)).size

  // New pockets can go on any ready branch that still has room.
  const roomy = branches.filter(
    (b) => active.items.filter((p) => p.branch?._id === b._id).length < MAX_POCKETS_PER_BRANCH,
  )

  const tabs = (
    <NavTabs
      label="Pockets"
      current={query.status}
      items={[
        { key: "active", label: active.items.length ? `Open (${active.items.length})` : "Open", href: href("active") },
        { key: "closed", label: "Closed", href: href("closed") },
      ]}
    />
  )

  const sheet = (
    <PocketSheet
      pocket={open ?? null}
      availableKobo={open ? (branches.find((b) => b._id === open.branch?._id)?.availableKobo ?? null) : null}
      branches={branches}
      onClose={() => router.replace(`${pathname}${href(query.status)}`, { scroll: false })}
    />
  )

  // Nothing saved yet: one calm empty state in place of the summary.
  if (query.status === "active" && active.items.length === 0) {
    return (
      <div className="grid gap-6">
        <Empty className="surface min-h-96 border-0 p-10">
          <EmptyHeader>
            <EmptyMedia variant="icon" className="bg-pop-subtle text-foreground">
              <PiggyBank aria-hidden />
            </EmptyMedia>
            <EmptyTitle className="type-display text-2xl">Set money aside for what&apos;s coming</EmptyTitle>
            <EmptyDescription>
              Pockets keep money for tax, payroll or rent apart from what you spend. Save by hand or a little from every payment
              in, and move it back whenever you need it.
            </EmptyDescription>
          </EmptyHeader>
          {newPocket && <EmptyContent>{newPocket}</EmptyContent>}
        </Empty>
        <p className="text-center text-sm text-muted-foreground">
          <Link href={href("closed")} className="underline-offset-4 hover:text-foreground hover:underline">
            View closed pockets
          </Link>
        </p>
        {sheet}
      </div>
    )
  }

  return (
    <div className="grid gap-8">
      <section aria-labelledby="saved-total" className="surface grid gap-6 p-6 sm:p-8 md:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] md:items-end">
        <div className="grid gap-1.5">
          <p id="saved-total" className="text-sm text-muted-foreground">
            Total saved
          </p>
          <p className="type-display text-[2.75rem] break-all sm:text-6xl figure">
            <BalanceAmount kobo={active.savedKobo} />
          </p>
          <p className="text-sm text-muted-foreground">
            {active.items.length === 0
              ? "No open pockets"
              : `In ${active.items.length} ${active.items.length === 1 ? "pocket" : "pockets"}${
                  showBranch && branchCount > 1 ? ` across ${branchCount} branches` : ""
                }`}
          </p>
        </div>
        <p className="text-sm leading-relaxed text-pretty text-muted-foreground md:text-right">
          Saved money stays in your accounts but is left out of the available balance, so transfers can&apos;t spend it.
        </p>
      </section>

      <div className="grid gap-6">
        {tabs}
        {pockets.length === 0 ? (
          <p className="surface px-6 py-10 text-center text-sm text-muted-foreground">
            {query.status === "closed" ? "No closed pockets. Closed pockets stay here with their history." : "No open pockets."}
          </p>
        ) : (
          <ul className="stagger grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
            {pockets.map((p, i) => (
              <li key={p._id} style={{ "--i": i } as React.CSSProperties}>
                <PocketCard pocket={p} showBranch={showBranch} href={href(query.status, p._id)} />
              </li>
            ))}
            {query.status === "active" && canManage && !readOnly && roomy.length > 0 && (
              <li style={{ "--i": pockets.length } as React.CSSProperties}>
                <PocketFormDialog branches={roomy} defaultBranchId={roomy.length === 1 ? roomy[0]._id : undefined}>
                  <button
                    type="button"
                    className={cn(
                      "grid h-full min-h-48 w-full place-content-center justify-items-center gap-3 rounded-2xl border-2 border-dashed p-6 text-sm text-muted-foreground",
                      "transition-colors duration-200 hover:border-primary/40 hover:text-foreground",
                      "focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                    )}
                  >
                    <span className="grid size-10 place-items-center rounded-[12px] bg-muted">
                      <Plus className="size-5" aria-hidden />
                    </span>
                    New pocket
                  </button>
                </PocketFormDialog>
              </li>
            )}
          </ul>
        )}
      </div>
      {sheet}
    </div>
  )
}

function PocketCard({ pocket: p, showBranch, href }: { pocket: Pocket; showBranch: boolean; href: string }) {
  const auto = p.status === "active" ? describeAutoSave(p.autoSave) : null
  return (
    <Link
      href={href}
      scroll={false}
      aria-label={`${p.name}, ${formatNaira(p.balanceKobo)}`}
      className={cn(
        "surface grid h-full content-between gap-6 p-6 transition-[box-shadow,transform] duration-200",
        "hover:-translate-y-0.5 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none motion-reduce:hover:translate-y-0",
        p.status === "closed" && "opacity-80",
      )}
    >
      <div className="flex items-start gap-3.5">
        <PocketTile icon={p.icon} color={p.color} />
        <div className="grid min-w-0 gap-1.5">
          <h3 className="truncate font-display text-lg leading-tight font-semibold tracking-[-0.02em]">{p.name}</h3>
          {showBranch && p.branch && <p className="-mt-1 truncate text-xs text-muted-foreground">{p.branch.name}</p>}
          <PocketTags pocket={p} />
        </div>
      </div>

      <div className="grid gap-3">
        <p className="type-display text-3xl figure">{formatNaira(p.balanceKobo)}</p>
        {p.target && p.status === "active" ? (
          <div className="grid gap-2">
            <PocketProgress bps={p.target.progressBps} color={p.color} />
            <TargetLine pocket={p} />
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            {p.status === "closed" ? `Closed ${formatDate(p.closedAt ?? undefined)}` : (auto ?? "No target")}
          </p>
        )}
      </div>
    </Link>
  )
}
