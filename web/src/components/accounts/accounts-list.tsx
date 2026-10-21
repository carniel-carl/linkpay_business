"use client"

import Link from "next/link"
import { ArrowRight, Landmark, RotateCw } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { AccountsResult } from "@/lib/accounts"
import type { Account, AccountSetupStatus, AccountWithBalance } from "@/lib/api/types"
import { formatNaira } from "@/lib/format"
import { AccountSetupNotice, ProviderDownNotice } from "./account-notices"
import { availableKobo, HeldNote, heldKobo, SavedNote, savedKobo } from "./balance"
import { CopyButton, shareText } from "./copy-button"
import { useAccounts } from "./use-accounts"

type Props = { initial: AccountsResult; setupStatus: AccountSetupStatus; fallback: Account[] }

/** Every account the business holds (one per branch), or the selected branch's. */
export function AccountsList({ initial, setupStatus, fallback }: Props) {
  const { result, failed, polling, refreshing, refresh } = useAccounts(initial, setupStatus)

  if (result.state === "setting_up") {
    return <AccountSetupNotice failed={failed} polling={polling} refreshing={refreshing} onCheck={refresh} />
  }
  const accounts: AccountWithBalance[] =
    result.state === "ready" ? result.accounts : fallback.map((a) => ({ ...a, balance: null }))
  if (accounts.length === 0) return <ProviderDownNotice refreshing={refreshing} onRetry={refresh} />

  const allKnown = accounts.every((a) => a.balance)
  // Integer kobo sums; only shown when every balance is known.
  const totalKobo = allKnown ? accounts.reduce((sum, a) => sum + availableKobo(a.balance!), 0) : null
  const totalHeldKobo = allKnown ? accounts.reduce((sum, a) => sum + heldKobo(a.balance!), 0) : 0
  const totalSavedKobo = allKnown ? accounts.reduce((sum, a) => sum + savedKobo(a.balance!), 0) : 0

  return (
    <section className="surface overflow-hidden">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b p-6 sm:px-8">
        <div className="grid gap-1">
          <p className="text-sm text-muted-foreground">
            Available balance, {accounts.length} {accounts.length === 1 ? "account" : "accounts"}
          </p>
          {totalKobo !== null ? (
            <>
              <p className="type-display text-4xl sm:text-5xl figure">{formatNaira(totalKobo)}</p>
              <HeldNote kobo={totalHeldKobo} className="text-sm" />
              <SavedNote kobo={totalSavedKobo} className="text-sm" />
            </>
          ) : (
            <p className="type-display text-3xl text-muted-foreground">Balance unavailable</p>
          )}
        </div>
        {(!allKnown || result.state !== "ready") && (
          <Button variant="outline" size="sm" onClick={refresh} disabled={refreshing}>
            {refreshing ? <Spinner /> : <RotateCw data-icon="inline-start" aria-hidden />}
            Retry balances
          </Button>
        )}
      </div>

      {/* Desktop: table */}
      <div className="hidden md:block">
        <Table>
          <TableHeader className="bg-muted/60">
            <TableRow className="hover:bg-transparent">
              <TableHead className="h-10 pl-8">Account</TableHead>
              <TableHead className="h-10">Bank</TableHead>
              <TableHead className="h-10">Account number</TableHead>
              <TableHead className="h-10 text-right">Available</TableHead>
              <TableHead className="h-10">Status</TableHead>
              <TableHead className="h-10 pr-8">
                <span className="sr-only">Transactions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {accounts.map((a) => (
              <TableRow key={a._id} className="h-16">
                <TableCell className="pl-8">
                  <div className="flex items-center gap-2 font-medium">
                    {a.label}
                    {isHeadOffice(a) && <Badge variant="muted">Head office</Badge>}
                  </div>
                  <div className="max-w-64 truncate text-xs text-muted-foreground">{a.accountName}</div>
                </TableCell>
                <TableCell className="text-muted-foreground">{a.bankName ?? "Partner bank"}</TableCell>
                <TableCell>
                  <span className="flex items-center gap-0.5">
                    <span className="font-mono tracking-[0.04em]">{a.accountNumber}</span>
                    <CopyButton value={a.accountNumber} message="Account number copied" label={`Copy ${a.label} account number`} />
                  </span>
                </TableCell>
                <TableCell className="text-right">
                  <AccountBalance account={a} />
                </TableCell>
                <TableCell>
                  <AccountStateBadge status={a.status} />
                </TableCell>
                <TableCell className="pr-8 text-right">
                  <Button variant="ghost" size="sm" asChild>
                    <Link href={transactionsHref(a)} aria-label={`View ${a.label} transactions`}>
                      Transactions
                      <ArrowRight data-icon="inline-end" aria-hidden />
                    </Link>
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Mobile: stacked cards */}
      <ul className="divide-y md:hidden">
        {accounts.map((a) => (
          <li key={a._id} className="grid gap-4 p-5">
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <span className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-brand-subtle text-primary">
                  <Landmark className="size-4" aria-hidden />
                </span>
                <div className="grid min-w-0">
                  <span className="flex items-center gap-2 truncate font-medium">
                    {a.label}
                    {isHeadOffice(a) && <Badge variant="muted">Head office</Badge>}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">{a.bankName ?? "Partner bank"}</span>
                </div>
              </div>
              <AccountStateBadge status={a.status} />
            </div>
            <div className="flex items-end justify-between gap-3">
              <div className="grid gap-0.5">
                <span className="text-xs text-muted-foreground">Account number</span>
                <span className="flex items-center gap-0.5">
                  <span className="font-mono text-lg tracking-[0.04em]">{a.accountNumber}</span>
                  <CopyButton value={a.accountNumber} message="Account number copied" label={`Copy ${a.label} account number`} />
                </span>
              </div>
              <span className="text-right">
                <AccountBalance account={a} />
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              <CopyButton value={shareText(a)} message="Account details copied" label="Share account details" variant="outline">
                Share account details
              </CopyButton>
              <Button variant="ghost" size="sm" asChild>
                <Link href={transactionsHref(a)} aria-label={`View ${a.label} transactions`}>
                  View transactions
                  <ArrowRight data-icon="inline-end" aria-hidden />
                </Link>
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** Available to send, with what transfers are holding underneath. */
function AccountBalance({ account }: { account: AccountWithBalance }) {
  if (!account.balance) return <span className="text-muted-foreground">Unavailable</span>
  return (
    <span className="grid justify-items-end gap-0.5">
      <span className="font-medium figure">{formatNaira(availableKobo(account.balance))}</span>
      <HeldNote kobo={heldKobo(account.balance)} short />
      <SavedNote kobo={savedKobo(account.balance)} short />
    </span>
  )
}

const isHeadOffice = (a: AccountWithBalance) => typeof a.branch === "object" && a.branch.isHeadOffice

/** This account's branch on the Transactions page. */
function transactionsHref(a: AccountWithBalance) {
  const id = typeof a.branch === "object" ? a.branch._id : a.branch
  return id ? `/transactions?branch=${encodeURIComponent(id)}` : "/transactions"
}

export function AccountStateBadge({ status }: { status: string }) {
  if (status === "active") return <Badge variant="success">Active</Badge>
  return <Badge variant="muted">{status.charAt(0).toUpperCase() + status.slice(1)}</Badge>
}
