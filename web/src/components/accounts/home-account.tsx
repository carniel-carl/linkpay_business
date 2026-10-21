"use client"

import { useSyncExternalStore } from "react"
import { ArrowDownLeft, Landmark, RotateCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Spinner } from "@/components/ui/spinner"
import type { AccountsResult } from "@/lib/accounts"
import { RecentTransactions } from "@/components/transactions/recent-transactions"
import type { Account, AccountSetupStatus, AccountWithBalance, Transaction } from "@/lib/api/types"
import { formatNaira } from "@/lib/format"
import { AccountSetupNotice, ProviderDownNotice } from "./account-notices"
import { availableKobo, HeldNote, heldKobo, SavedNote, savedKobo } from "./balance"
import { CopyButton, shareText } from "./copy-button"
import { useAccounts } from "./use-accounts"

type Props = {
  businessId: string
  initial: AccountsResult
  setupStatus: AccountSetupStatus
  /** Account details from GET /api/business, used if balances can't be loaded. */
  fallback?: Account
  /** The one-time "your account is ready" welcome is for whoever runs the business, not every staff member. */
  showWelcome?: boolean
  /** Latest transactions and this month's money in; null when they couldn't load. */
  recent: { items: Transaction[]; moneyInKobo: number | null; showBranch: boolean } | null
}

/** Home for an approved business: the main account, a one-time welcome, and transactions. */
export function HomeAccount({ businessId, initial, setupStatus, fallback, showWelcome = true, recent }: Props) {
  const { result, failed, polling, refreshing, refresh } = useAccounts(initial, setupStatus)

  if (result.state === "setting_up") {
    return <AccountSetupNotice failed={failed} polling={polling} refreshing={refreshing} onCheck={refresh} />
  }

  // Details can still show from the overview when balances can't be fetched.
  const account: AccountWithBalance | undefined =
    result.state === "ready"
      ? (result.accounts.find((a) => typeof a.branch === "object" && a.branch.isHeadOffice) ?? result.accounts[0])
      : fallback
        ? { ...fallback, balance: null }
        : undefined

  if (!account) return <ProviderDownNotice refreshing={refreshing} onRetry={refresh} />

  return (
    <div className="grid gap-8">
      {showWelcome && result.state === "ready" && <WelcomeBanner businessId={businessId} account={account} />}
      <AccountCard account={account} refreshing={refreshing} onRetry={refresh} />
      {recent && recent.items.length > 0 ? (
        <RecentTransactions items={recent.items} moneyInKobo={recent.moneyInKobo} showBranch={recent.showBranch} />
      ) : (
        <Transactions account={account} unavailable={!recent} />
      )}
    </div>
  )
}

function AccountCard({
  account,
  refreshing,
  onRetry,
}: {
  account: AccountWithBalance
  refreshing: boolean
  onRetry: () => void
}) {
  return (
    <section
      aria-labelledby="account-title"
      className="surface grid overflow-hidden md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]"
    >
      <div className="grid content-between gap-10 p-6 sm:p-9">
        <div className="flex items-center gap-2.5 text-sm text-muted-foreground">
          <span className="grid size-8 place-items-center rounded-[10px] bg-brand-subtle text-primary">
            <Landmark className="size-4" aria-hidden />
          </span>
          <span id="account-title">{account.label}</span>
        </div>

        <div className="grid gap-2" aria-live="polite">
          <p className="text-sm text-muted-foreground">Available balance</p>
          {account.balance ? (
            <>
              <p className="type-display text-[2.75rem] break-all sm:text-6xl figure">
                {formatNaira(availableKobo(account.balance))}
              </p>
              <HeldNote kobo={heldKobo(account.balance)} className="text-sm" />
              <SavedNote kobo={savedKobo(account.balance)} className="text-sm" />
            </>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <p className="type-display text-3xl text-muted-foreground sm:text-4xl">Balance unavailable</p>
              <Button variant="ghost" size="sm" onClick={onRetry} disabled={refreshing}>
                {refreshing ? <Spinner /> : <RotateCw data-icon="inline-start" aria-hidden />}
                Retry
              </Button>
            </div>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          <CopyButton
            value={shareText(account)}
            message="Account details copied"
            label="Share account details"
            variant="default"
            size="default"
          >
            Share account details
          </CopyButton>
          <CopyButton
            value={account.accountNumber}
            message="Account number copied"
            label="Copy account number"
            variant="outline"
            size="default"
          >
            Copy number
          </CopyButton>
        </div>
      </div>

      <dl className="grid content-center gap-5 border-t bg-muted/60 p-6 sm:p-9 md:border-t-0 md:border-l">
        <div className="grid gap-1">
          <dt className="text-xs text-muted-foreground">Account number</dt>
          <dd className="flex items-center gap-1">
            <span className="font-mono text-2xl font-medium tracking-[0.06em]">{account.accountNumber}</span>
            <CopyButton value={account.accountNumber} message="Account number copied" label="Copy account number" />
          </dd>
        </div>
        <Fact label="Account name" value={account.accountName} />
        <Fact label="Bank" value={account.bankName} />
        <Fact label="Currency" value="Nigerian naira (NGN)" />
      </dl>
    </section>
  )
}

function Fact({ label, value }: { label: string; value?: string }) {
  return (
    <div className="grid gap-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-[15px] font-medium break-words">{value || "Not provided yet"}</dd>
    </div>
  )
}

/** No payments yet: an honest empty state that tells them how to fund the account. */
function Transactions({ account, unavailable }: { account: AccountWithBalance; unavailable: boolean }) {
  return (
    <section aria-labelledby="transactions-title" className="grid gap-4">
      <div className="flex items-baseline justify-between gap-4 px-1">
        <h2 id="transactions-title" className="font-display text-lg font-semibold tracking-[-0.02em]">
          Transactions
        </h2>
      </div>
      <Empty className="surface min-h-64 border-0 p-8">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ArrowDownLeft aria-hidden />
          </EmptyMedia>
          <EmptyTitle>{unavailable ? "Recent payments aren't available right now" : "No transactions yet"}</EmptyTitle>
          <EmptyDescription>
            {unavailable ? (
              "We couldn't load them just now. Refresh the page in a moment, or open Transactions."
            ) : (
              <>
                Fund your account by bank transfer to{" "}
                <span className="font-mono font-medium text-foreground">{account.accountNumber}</span>
                {account.bankName ? ` at ${account.bankName}` : ""}. Payments you receive and send will be listed here.
              </>
            )}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </section>
  )
}

// ---- One-time welcome banner (dismissal remembered per business in localStorage) ----

const storageKey = (businessId: string) => `linkpay:welcome-dismissed:${businessId}`
const DISMISS_EVENT = "linkpay:welcome-dismissed"

function readDismissed(businessId: string) {
  try {
    return window.localStorage.getItem(storageKey(businessId)) === "1"
  } catch {
    return false
  }
}

function subscribe(onChange: () => void) {
  window.addEventListener(DISMISS_EVENT, onChange)
  window.addEventListener("storage", onChange)
  return () => {
    window.removeEventListener(DISMISS_EVENT, onChange)
    window.removeEventListener("storage", onChange)
  }
}

function WelcomeBanner({ businessId, account }: { businessId: string; account: AccountWithBalance }) {
  // Server snapshot is "dismissed", so the banner never flashes during hydration.
  const dismissed = useSyncExternalStore(
    subscribe,
    () => readDismissed(businessId),
    () => true,
  )
  if (dismissed) return null

  function dismiss() {
    try {
      window.localStorage.setItem(storageKey(businessId), "1")
    } catch {
      // Storage blocked (private mode): hide for this visit only.
    }
    window.dispatchEvent(new Event(DISMISS_EVENT))
  }

  return (
    <section
      aria-labelledby="welcome-title"
      className="surface grid gap-x-8 gap-y-5 p-6 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end sm:p-8"
    >
      <div className="grid min-w-0 gap-2">
        <p className="flex items-center gap-2 text-xs font-medium tracking-[0.12em] text-muted-foreground uppercase">
          <span className="size-1.5 rounded-full bg-success ring-4 ring-success-subtle" aria-hidden />
          Account open
        </p>
        <h2 id="welcome-title" className="type-display text-[1.625rem] text-balance sm:text-[1.875rem]">
          Your business account is ready
        </h2>
        <p className="max-w-[56ch] text-[15px] leading-relaxed text-pretty text-muted-foreground">
          Give customers your account number,{" "}
          <span className="font-mono font-medium tracking-[0.04em] text-foreground">{account.accountNumber}</span>
          {account.bankName ? ` at ${account.bankName}` : ""}. Money they send lands in the balance below straight away.
        </p>
      </div>
      {/* Sharing lives on the account card just below, so the note only needs closing. */}
      <Button variant="outline" className="w-fit" onClick={dismiss}>
        Got it
      </Button>
    </section>
  )
}
