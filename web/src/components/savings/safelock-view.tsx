"use client"

import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { Lock, Plus } from "lucide-react"
import { NavTabs } from "@/components/common/nav-tabs"
import { Badge } from "@/components/ui/badge"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import type { Safelock, SafelockLimits, SafelockList } from "@/lib/api/types"
import { formatNaira } from "@/lib/format"
import { daysLeftLabel, formatDay, type SavingsQuery } from "@/lib/savings"
import { cn } from "@/lib/utils"
import type { PocketBranch } from "./pocket-form-dialog"
import { SafelockFormDialog } from "./safelock-form-dialog"
import { LockProgress, SafelockTile } from "./safelock-parts"
import { SafelockSheet } from "./safelock-sheet"

type Props = {
  locked: SafelockList
  /** Released locks, when that tab is showing. */
  released: Safelock[] | null
  query: SavingsQuery
  /** A lock opened by link (?safelock=) that isn't in the lists on screen. */
  linked: Safelock | null
  /** Branches that can still take a new lock (ready account, under the per-branch limit). */
  branches: PocketBranch[]
  limits: SafelockLimits | null
  canManage: boolean
  showBranch: boolean
  newSafelock: React.ReactNode
}

function href(status: SavingsQuery["lockStatus"], safelock?: string) {
  const params = new URLSearchParams({ view: "safelock" })
  if (status === "released") params.set("status", "released")
  if (safelock) params.set("safelock", safelock)
  return `?${params}`
}

export function SafelockView({ locked, released, query, linked, branches, limits, canManage, showBranch, newSafelock }: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const items = query.lockStatus === "released" ? (released ?? []) : locked.items
  const open = query.safelock
    ? (locked.items.find((s) => s._id === query.safelock) ?? released?.find((s) => s._id === query.safelock) ?? linked)
    : null
  const branchCount = new Set(locked.items.map((s) => s.branch?._id)).size

  const sheet = <SafelockSheet safelock={open ?? null} onClose={() => router.replace(`${pathname}${href(query.lockStatus)}`, { scroll: false })} />

  // Nothing locked yet: one calm empty state in place of the summary.
  if (query.lockStatus === "locked" && locked.items.length === 0) {
    return (
      <div className="grid gap-6">
        <Empty className="surface min-h-96 border-0 p-10">
          <EmptyHeader>
            <EmptyMedia variant="icon" className="bg-brand-subtle text-primary">
              <Lock aria-hidden />
            </EmptyMedia>
            <EmptyTitle className="type-display text-2xl">Lock money away until you need it</EmptyTitle>
            <EmptyDescription>
              A Safelock keeps an amount out of reach until a date you choose, for rent, tax or a big purchase. Nobody can spend or
              take it out early, so it&apos;s there when the day comes.
            </EmptyDescription>
          </EmptyHeader>
          {newSafelock && <EmptyContent>{newSafelock}</EmptyContent>}
        </Empty>
        <p className="text-center text-sm text-muted-foreground">
          <Link href={href("released")} className="underline-offset-4 hover:text-foreground hover:underline">
            View unlocked Safelocks
          </Link>
        </p>
        {sheet}
      </div>
    )
  }

  return (
    <div className="grid gap-8">
      <section aria-labelledby="locked-total" className="surface grid gap-6 p-6 sm:p-8 md:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] md:items-end">
        <div className="grid gap-1.5">
          <p id="locked-total" className="text-sm text-muted-foreground">
            Total locked
          </p>
          <p className="type-display text-[2.75rem] break-all sm:text-6xl figure">{formatNaira(locked.lockedKobo)}</p>
          <p className="text-sm text-muted-foreground">
            {locked.items.length === 0
              ? "Nothing locked right now"
              : `In ${locked.items.length} ${locked.items.length === 1 ? "Safelock" : "Safelocks"}${
                  showBranch && branchCount > 1 ? ` across ${branchCount} branches` : ""
                }`}
          </p>
        </div>
        <p className="text-sm leading-relaxed text-pretty text-muted-foreground md:text-right">
          Locked money stays in your accounts but can&apos;t be spent or taken out before its unlock date. It comes back by itself
          on the day. No interest yet.
        </p>
      </section>

      <div className="grid gap-6">
        <NavTabs
          label="Safelocks"
          current={query.lockStatus}
          items={[
            { key: "locked", label: locked.items.length ? `Locked (${locked.items.length})` : "Locked", href: href("locked") },
            { key: "released", label: "Unlocked", href: href("released") },
          ]}
        />
        {items.length === 0 ? (
          <p className="surface px-6 py-10 text-center text-sm text-muted-foreground">
            {query.lockStatus === "released" ? "Nothing has unlocked yet. Safelocks show here once their date comes." : "Nothing locked."}
          </p>
        ) : (
          <ul className="stagger grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
            {items.map((s, i) => (
              <li key={s._id} style={{ "--i": i } as React.CSSProperties}>
                <SafelockCard lock={s} showBranch={showBranch} href={href(query.lockStatus, s._id)} />
              </li>
            ))}
            {query.lockStatus === "locked" && canManage && limits && branches.length > 0 && (
              <li style={{ "--i": items.length } as React.CSSProperties}>
                <SafelockFormDialog branches={branches} limits={limits} defaultBranchId={branches.length === 1 ? branches[0]._id : undefined}>
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
                    New Safelock
                  </button>
                </SafelockFormDialog>
              </li>
            )}
          </ul>
        )}
      </div>
      {sheet}
    </div>
  )
}

function SafelockCard({ lock: s, showBranch, href }: { lock: Safelock; showBranch: boolean; href: string }) {
  const released = s.status === "released"
  return (
    <Link
      href={href}
      scroll={false}
      aria-label={`${s.title}, ${formatNaira(s.amountKobo)}, ${released ? "unlocked" : `unlocks ${formatDay(s.unlockOn)}`}`}
      className={cn(
        "surface grid h-full content-between gap-6 p-6 transition-[box-shadow,transform] duration-200",
        "hover:-translate-y-0.5 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none motion-reduce:hover:translate-y-0",
        released && "opacity-80",
      )}
    >
      <div className="flex items-start gap-3.5">
        <SafelockTile released={released} />
        <div className="grid min-w-0 gap-1.5">
          <h3 className="truncate font-display text-lg leading-tight font-semibold tracking-[-0.02em]">{s.title}</h3>
          {showBranch && s.branch && <p className="-mt-1 truncate text-xs text-muted-foreground">{s.branch.name}</p>}
          {released ? (
            <span>
              <Badge variant="success">Unlocked</Badge>
            </span>
          ) : (
            s.daysLeft <= 7 && (
              <span>
                <Badge variant="outline">{daysLeftLabel(s.daysLeft)}</Badge>
              </span>
            )
          )}
        </div>
      </div>

      <div className="grid gap-3">
        <p className="type-display text-3xl figure">{formatNaira(s.amountKobo)}</p>
        {released ? (
          <p className="text-xs text-muted-foreground">Unlocked {formatDay(s.unlockOn)}, back in the available balance</p>
        ) : (
          <div className="grid gap-2">
            <LockProgress bps={s.progressBps} label={`${s.title}: time locked so far`} />
            <p className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
              <span>{daysLeftLabel(s.daysLeft)}</span>
              <span>Unlocks {formatDay(s.unlockOn)}</span>
            </p>
          </div>
        )}
      </div>
    </Link>
  )
}
